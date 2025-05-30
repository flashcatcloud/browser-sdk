import { round, ONE_SECOND, noop, elapsed } from '@flashcatcloud/browser-core'
import type { Duration, RelativeTime, WeakRef, WeakRefConstructor } from '@flashcatcloud/browser-core'
import { isElementNode } from '../../../browser/htmlDomUtils'
import type { RumLayoutShiftAttribution, RumLayoutShiftTiming } from '../../../browser/performanceObservable'
import {
  supportPerformanceTimingEvent,
  RumPerformanceEntryType,
  createPerformanceObservable,
} from '../../../browser/performanceObservable'
import { getSelectorFromElement } from '../../getSelectorFromElement'
import type { RumConfiguration } from '../../configuration'
import type { RumRect } from '../../../rumEvent.types'
import { getClsAttributionImpactedArea } from './getClsAttributionImpactedArea'

declare const WeakRef: WeakRefConstructor

export interface CumulativeLayoutShift {
  value: number
  targetSelector?: string
  time?: Duration
  previousRect?: RumRect
  currentRect?: RumRect
  devicePixelRatio?: number
}

interface LayoutShiftInstance {
  target: WeakRef<Element> | undefined
  time: Duration
  previousRect: DOMRectReadOnly | undefined
  currentRect: DOMRectReadOnly | undefined
  devicePixelRatio: number
}

/**
 * Track the cumulative layout shifts (CLS).
 * Layout shifts are grouped into session windows.
 * The minimum gap between session windows is 1 second.
 * The maximum duration of a session window is 5 second.
 * The session window layout shift value is the sum of layout shifts inside it.
 * The CLS value is the max of session windows values.
 *
 * This yields a new value whenever the CLS value is updated (a higher session window value is computed).
 *
 * See isLayoutShiftSupported to check for browser support.
 *
 * Documentation:
 * https://web.dev/cls/
 * https://web.dev/evolving-cls/
 * Reference implementation: https://github.com/GoogleChrome/web-vitals/blob/master/src/getCLS.ts
 */
export function trackCumulativeLayoutShift(
  configuration: RumConfiguration,
  viewStart: RelativeTime,
  callback: (cumulativeLayoutShift: CumulativeLayoutShift) => void
) {
  if (!isLayoutShiftSupported()) {
    return {
      stop: noop,
    }
  }

  let maxClsValue = 0
  let biggestShift: LayoutShiftInstance | undefined

  // if no layout shift happen the value should be reported as 0
  callback({
    value: 0,
  })

  const slidingWindow = slidingSessionWindow()
  const performanceSubscription = createPerformanceObservable(configuration, {
    type: RumPerformanceEntryType.LAYOUT_SHIFT,
    buffered: true,
  }).subscribe((entries) => {
    for (const entry of entries) {
      if (entry.hadRecentInput || entry.startTime < viewStart) {
        continue
      }

      const { cumulatedValue, isMaxValue } = slidingWindow.update(entry)

      if (isMaxValue) {
        const attribution = getTopImpactedElement(entry.sources)
        biggestShift = {
          target: attribution?.node ? new WeakRef(attribution.node) : undefined,
          time: elapsed(viewStart, entry.startTime),
          previousRect: attribution?.previousRect,
          currentRect: attribution?.currentRect,
          devicePixelRatio: window.devicePixelRatio,
        }
      }

      if (cumulatedValue > maxClsValue) {
        maxClsValue = cumulatedValue
        const target = biggestShift?.target?.deref()

        callback({
          value: round(maxClsValue, 4),
          targetSelector: target && getSelectorFromElement(target, configuration.actionNameAttribute),
          time: biggestShift?.time,
          previousRect: biggestShift?.previousRect ? asRumRect(biggestShift.previousRect) : undefined,
          currentRect: biggestShift?.currentRect ? asRumRect(biggestShift.currentRect) : undefined,
          devicePixelRatio: biggestShift?.devicePixelRatio,
        })
      }
    }
  })

  return {
    stop: () => {
      performanceSubscription.unsubscribe()
    },
  }
}

function getTopImpactedElement(
  sources: RumLayoutShiftAttribution[]
): (RumLayoutShiftAttribution & { node: Element }) | undefined {
  let topImpactedSource: (RumLayoutShiftAttribution & { node: Element }) | undefined
  for (const source of sources) {
    if (source.node && isElementNode(source.node)) {
      const currentImpactedArea = getClsAttributionImpactedArea(source)
      if (!topImpactedSource || getClsAttributionImpactedArea(topImpactedSource) < currentImpactedArea) {
        topImpactedSource = source as RumLayoutShiftAttribution & { node: Element }
      }
    }
  }
  return topImpactedSource
}

function asRumRect({ x, y, width, height }: DOMRectReadOnly): RumRect {
  return { x, y, width, height }
}

export const MAX_WINDOW_DURATION = 5 * ONE_SECOND
const MAX_UPDATE_GAP = ONE_SECOND

function slidingSessionWindow() {
  let cumulatedValue = 0
  let startTime: RelativeTime
  let endTime: RelativeTime
  let maxValue = 0

  return {
    update: (entry: RumLayoutShiftTiming) => {
      const shouldCreateNewWindow =
        startTime === undefined ||
        entry.startTime - endTime >= MAX_UPDATE_GAP ||
        entry.startTime - startTime >= MAX_WINDOW_DURATION

      let isMaxValue: boolean

      if (shouldCreateNewWindow) {
        startTime = endTime = entry.startTime
        maxValue = cumulatedValue = entry.value
        isMaxValue = true
      } else {
        cumulatedValue += entry.value
        endTime = entry.startTime
        isMaxValue = entry.value > maxValue

        if (isMaxValue) {
          maxValue = entry.value
        }
      }

      return {
        cumulatedValue,
        isMaxValue,
      }
    },
  }
}

/**
 * Check whether `layout-shift` is supported by the browser.
 */
export function isLayoutShiftSupported() {
  return supportPerformanceTimingEvent(RumPerformanceEntryType.LAYOUT_SHIFT) && 'WeakRef' in window
}
