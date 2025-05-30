import { elapsed, noop, ONE_MINUTE } from '@flashcatcloud/browser-core'
import type { Duration, RelativeTime } from '@flashcatcloud/browser-core'
import {
  createPerformanceObservable,
  RumPerformanceEntryType,
  supportPerformanceTimingEvent,
} from '../../../browser/performanceObservable'
import type { RumFirstInputTiming, RumPerformanceEventTiming } from '../../../browser/performanceObservable'
import { ViewLoadingType } from '../../../rawRumEvent.types'
import { getSelectorFromElement } from '../../getSelectorFromElement'
import { isElementNode } from '../../../browser/htmlDomUtils'
import { getInteractionSelector } from '../../action/interactionSelectorCache'
import type { RumConfiguration } from '../../configuration'
import { getInteractionCount, initInteractionCountPolyfill } from './interactionCountPolyfill'

// Arbitrary value to prevent unnecessary memory usage on views with lots of interactions.
const MAX_INTERACTION_ENTRIES = 10
// Arbitrary value to cap INP outliers
export const MAX_INP_VALUE = (1 * ONE_MINUTE) as Duration

export interface InteractionToNextPaint {
  value: Duration
  targetSelector?: string
  time?: Duration
}
/**
 * Track the interaction to next paint (INP).
 * To avoid outliers, return the p98 worst interaction of the view.
 * Documentation: https://web.dev/inp/
 * Reference implementation: https://github.com/GoogleChrome/web-vitals/blob/main/src/onINP.ts
 */
export function trackInteractionToNextPaint(
  configuration: RumConfiguration,
  viewStart: RelativeTime,
  viewLoadingType: ViewLoadingType
) {
  if (!isInteractionToNextPaintSupported()) {
    return {
      getInteractionToNextPaint: () => undefined,
      setViewEnd: noop,
      stop: noop,
    }
  }

  const { getViewInteractionCount, stopViewInteractionCount } = trackViewInteractionCount(viewLoadingType)

  let viewEnd = Infinity as RelativeTime

  const longestInteractions = trackLongestInteractions(getViewInteractionCount)
  let interactionToNextPaint = -1 as Duration
  let interactionToNextPaintTargetSelector: string | undefined
  let interactionToNextPaintStartTime: Duration | undefined

  function handleEntries(entries: Array<RumPerformanceEventTiming | RumFirstInputTiming>) {
    for (const entry of entries) {
      if (
        entry.interactionId &&
        // Check the entry start time is inside the view bounds because some view interactions can be reported after the view end (if long duration).
        entry.startTime >= viewStart &&
        entry.startTime <= viewEnd
      ) {
        longestInteractions.process(entry)
      }
    }

    const newInteraction = longestInteractions.estimateP98Interaction()
    if (newInteraction && newInteraction.duration !== interactionToNextPaint) {
      interactionToNextPaint = newInteraction.duration
      interactionToNextPaintStartTime = elapsed(viewStart, newInteraction.startTime)
      interactionToNextPaintTargetSelector = getInteractionSelector(newInteraction.startTime)
      if (!interactionToNextPaintTargetSelector && newInteraction.target && isElementNode(newInteraction.target)) {
        interactionToNextPaintTargetSelector = getSelectorFromElement(
          newInteraction.target,
          configuration.actionNameAttribute
        )
      }
    }
  }

  const firstInputSubscription = createPerformanceObservable(configuration, {
    type: RumPerformanceEntryType.FIRST_INPUT,
    buffered: true,
  }).subscribe(handleEntries)

  const eventSubscription = createPerformanceObservable(configuration, {
    type: RumPerformanceEntryType.EVENT,
    // durationThreshold only impact PerformanceEventTiming entries used for INP computation which requires a threshold at 40 (default is 104ms)
    // cf: https://github.com/GoogleChrome/web-vitals/blob/3806160ffbc93c3c4abf210a167b81228172b31c/src/onINP.ts#L202-L210
    durationThreshold: 40,
    buffered: true,
  }).subscribe(handleEntries)

  return {
    getInteractionToNextPaint: (): InteractionToNextPaint | undefined => {
      // If no INP duration where captured because of the performanceObserver 40ms threshold
      // but the view interaction count > 0 then report 0
      if (interactionToNextPaint >= 0) {
        return {
          value: Math.min(interactionToNextPaint, MAX_INP_VALUE) as Duration,
          targetSelector: interactionToNextPaintTargetSelector,
          time: interactionToNextPaintStartTime,
        }
      } else if (getViewInteractionCount()) {
        return {
          value: 0 as Duration,
        }
      }
    },
    setViewEnd: (viewEndTime: RelativeTime) => {
      viewEnd = viewEndTime
      stopViewInteractionCount()
    },
    stop: () => {
      eventSubscription.unsubscribe()
      firstInputSubscription.unsubscribe()
    },
  }
}

function trackLongestInteractions(getViewInteractionCount: () => number) {
  const longestInteractions: Array<RumPerformanceEventTiming | RumFirstInputTiming> = []

  function sortAndTrimLongestInteractions() {
    longestInteractions.sort((a, b) => b.duration - a.duration).splice(MAX_INTERACTION_ENTRIES)
  }

  return {
    /**
     * Process the performance entry:
     * - if its duration is long enough, add the performance entry to the list of worst interactions
     * - if an entry with the same interaction id exists and its duration is lower than the new one, then replace it in the list of worst interactions
     */
    process(entry: RumPerformanceEventTiming | RumFirstInputTiming) {
      const interactionIndex = longestInteractions.findIndex(
        (interaction) => entry.interactionId === interaction.interactionId
      )

      const minLongestInteraction = longestInteractions[longestInteractions.length - 1]

      if (interactionIndex !== -1) {
        if (entry.duration > longestInteractions[interactionIndex].duration) {
          longestInteractions[interactionIndex] = entry
          sortAndTrimLongestInteractions()
        }
      } else if (
        longestInteractions.length < MAX_INTERACTION_ENTRIES ||
        entry.duration > minLongestInteraction.duration
      ) {
        longestInteractions.push(entry)
        sortAndTrimLongestInteractions()
      }
    },
    /**
     * Compute the p98 longest interaction.
     * For better performance the computation is based on 10 longest interactions and the interaction count of the current view.
     */
    estimateP98Interaction(): RumPerformanceEventTiming | RumFirstInputTiming | undefined {
      const interactionIndex = Math.min(longestInteractions.length - 1, Math.floor(getViewInteractionCount() / 50))
      return longestInteractions[interactionIndex]
    },
  }
}

export function trackViewInteractionCount(viewLoadingType: ViewLoadingType) {
  initInteractionCountPolyfill()
  const previousInteractionCount = viewLoadingType === ViewLoadingType.INITIAL_LOAD ? 0 : getInteractionCount()
  let state: { stopped: false } | { stopped: true; interactionCount: number } = { stopped: false }

  function computeViewInteractionCount() {
    return getInteractionCount() - previousInteractionCount
  }

  return {
    getViewInteractionCount: () => {
      if (state.stopped) {
        return state.interactionCount
      }

      return computeViewInteractionCount()
    },
    stopViewInteractionCount: () => {
      state = { stopped: true, interactionCount: computeViewInteractionCount() }
    },
  }
}

export function isInteractionToNextPaintSupported() {
  return (
    supportPerformanceTimingEvent(RumPerformanceEntryType.EVENT) &&
    window.PerformanceEventTiming &&
    'interactionId' in PerformanceEventTiming.prototype
  )
}
