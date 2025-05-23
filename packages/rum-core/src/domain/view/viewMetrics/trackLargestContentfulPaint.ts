import type { RelativeTime } from '@flashcatcloud/browser-core'
import { DOM_EVENT, ONE_MINUTE, addEventListeners, findLast } from '@flashcatcloud/browser-core'
import type { RumConfiguration } from '../../configuration'
import { createPerformanceObservable, RumPerformanceEntryType } from '../../../browser/performanceObservable'
import type { RumLargestContentfulPaintTiming } from '../../../browser/performanceObservable'
import { getSelectorFromElement } from '../../getSelectorFromElement'
import type { FirstHidden } from './trackFirstHidden'

// Discard LCP timings above a certain delay to avoid incorrect data
// It happens in some cases like sleep mode or some browser implementations
export const LCP_MAXIMUM_DELAY = 10 * ONE_MINUTE

export interface LargestContentfulPaint {
  value: RelativeTime
  targetSelector?: string
  resourceUrl?: string
}

/**
 * Track the largest contentful paint (LCP) occurring during the initial View.  This can yield
 * multiple values, only the most recent one should be used.
 * Documentation: https://web.dev/lcp/
 * Reference implementation: https://github.com/GoogleChrome/web-vitals/blob/master/src/onLCP.ts
 */
export function trackLargestContentfulPaint(
  configuration: RumConfiguration,
  firstHidden: FirstHidden,
  eventTarget: Window,
  callback: (largestContentfulPaint: LargestContentfulPaint) => void
) {
  // Ignore entries that come after the first user interaction. According to the documentation, the
  // browser should not send largest-contentful-paint entries after a user interact with the page,
  // but the web-vitals reference implementation uses this as a safeguard.
  let firstInteractionTimestamp = Infinity
  const { stop: stopEventListener } = addEventListeners(
    configuration,
    eventTarget,
    [DOM_EVENT.POINTER_DOWN, DOM_EVENT.KEY_DOWN],
    (event) => {
      firstInteractionTimestamp = event.timeStamp
    },
    { capture: true, once: true }
  )

  let biggestLcpSize = 0
  const performanceLcpSubscription = createPerformanceObservable(configuration, {
    type: RumPerformanceEntryType.LARGEST_CONTENTFUL_PAINT,
    buffered: true,
  }).subscribe((entries) => {
    const lcpEntry = findLast(
      entries,
      (entry): entry is RumLargestContentfulPaintTiming =>
        entry.entryType === RumPerformanceEntryType.LARGEST_CONTENTFUL_PAINT &&
        entry.startTime < firstInteractionTimestamp &&
        entry.startTime < firstHidden.timeStamp &&
        entry.startTime < LCP_MAXIMUM_DELAY &&
        // Ensure to get the LCP entry with the biggest size, see
        // https://bugs.chromium.org/p/chromium/issues/detail?id=1516655
        entry.size > biggestLcpSize
    )
    if (lcpEntry) {
      let lcpTargetSelector
      if (lcpEntry.element) {
        lcpTargetSelector = getSelectorFromElement(lcpEntry.element, configuration.actionNameAttribute)
      }

      callback({
        value: lcpEntry.startTime,
        targetSelector: lcpTargetSelector,
        resourceUrl: computeLcpEntryUrl(lcpEntry),
      })
      biggestLcpSize = lcpEntry.size
    }
  })

  return {
    stop: () => {
      stopEventListener()
      performanceLcpSubscription.unsubscribe()
    },
  }
}

// The property url report an empty string if the value is not available, we shouldn't report it in this case.
function computeLcpEntryUrl(entry: RumLargestContentfulPaintTiming) {
  return entry.url === '' ? undefined : entry.url
}
