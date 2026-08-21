import type { ClocksState, Duration } from '@flashcatcloud/browser-core'
import {
  combine,
  generateUUID,
  RequestType,
  ResourceType,
  toServerDuration,
  relativeToClocks,
  createTaskQueue,
} from '@flashcatcloud/browser-core'
import type { RumConfiguration } from '../configuration'
import {
  RumPerformanceEntryType,
  createPerformanceObservable,
  type RumPerformanceResourceTiming,
} from '../../browser/performanceObservable'
import type { RumXhrResourceEventDomainContext, RumFetchResourceEventDomainContext } from '../../domainContext.types'
import type { RawRumResourceEvent } from '../../rawRumEvent.types'
import { RumEventType } from '../../rawRumEvent.types'
import { LifeCycleEventType } from '../lifeCycle'
import type { RawRumEventCollectedData, LifeCycle } from '../lifeCycle'
import type { RequestCompleteEvent } from '../requestCollection'
import type { RumSessionManager } from '../rumSessionManager'
import type { PageStateHistory } from '../contexts/pageStateHistory'
import { PageState } from '../contexts/pageStateHistory'
import { createSpanIdentifier } from '../tracing/identifier'
import { matchRequestResourceEntry } from './matchRequestResourceEntry'
import {
  computeResourceEntryDetails,
  computeResourceEntryDuration,
  computeResourceEntryType,
  computeResourceEntrySize,
  computeResourceEntryProtocol,
  computeResourceEntryDeliveryType,
  isResourceEntryRequestType,
  isLongDataUrl,
  sanitizeDataUrl,
} from './resourceUtils'
import { retrieveInitialDocumentResourceTiming } from './retrieveInitialDocumentResourceTiming'

export function startResourceCollection(
  lifeCycle: LifeCycle,
  configuration: RumConfiguration,
  pageStateHistory: PageStateHistory,
  sessionManager: RumSessionManager,
  taskQueue = createTaskQueue(),
  retrieveInitialDocumentResourceTimingImpl = retrieveInitialDocumentResourceTiming
) {
  lifeCycle.subscribe(LifeCycleEventType.REQUEST_COMPLETED, (request: RequestCompleteEvent) => {
    handleResource(() => processRequest(request, configuration, pageStateHistory, sessionManager))
  })

  const performanceResourceSubscription = createPerformanceObservable(configuration, {
    type: RumPerformanceEntryType.RESOURCE,
    buffered: true,
  }).subscribe((entries) => {
    for (const entry of entries) {
      if (!isResourceEntryRequestType(entry)) {
        handleResource(() => processResourceEntry(entry, configuration, sessionManager))
      }
    }
  })

  retrieveInitialDocumentResourceTimingImpl(configuration, (timing) => {
    handleResource(() => processResourceEntry(timing, configuration, sessionManager))
  })

  function handleResource(computeRawEvent: () => RawRumEventCollectedData<RawRumResourceEvent> | undefined) {
    taskQueue.push(() => {
      const rawEvent = computeRawEvent()
      if (rawEvent) {
        lifeCycle.notify(LifeCycleEventType.RAW_RUM_EVENT_COLLECTED, rawEvent)
      }
    })
  }

  return {
    stop: () => {
      performanceResourceSubscription.unsubscribe()
    },
  }
}

function processRequest(
  request: RequestCompleteEvent,
  configuration: RumConfiguration,
  pageStateHistory: PageStateHistory,
  sessionManager: RumSessionManager
): RawRumEventCollectedData<RawRumResourceEvent> | undefined {
  const matchingTiming = matchRequestResourceEntry(request)
  const startClocks = matchingTiming ? relativeToClocks(matchingTiming.startTime) : request.startClocks
  const tracingInfo = computeRequestTracingInfo(request, configuration, sessionManager)
  if (!configuration.trackResources && !tracingInfo) {
    return
  }

  const type = request.type === RequestType.XHR ? ResourceType.XHR : ResourceType.FETCH

  const correspondingTimingOverrides = matchingTiming ? computeResourceEntryMetrics(matchingTiming) : undefined

  const duration = matchingTiming
    ? computeResourceEntryDuration(matchingTiming)
    : computeRequestDuration(pageStateHistory, startClocks, request.duration)

  const resourceEvent = combine(
    {
      date: startClocks.timeStamp,
      resource: {
        id: generateUUID(),
        type,
        duration: toServerDuration(duration),
        method: request.method,
        status_code: request.status,
        protocol: matchingTiming && computeResourceEntryProtocol(matchingTiming),
        url: isLongDataUrl(request.url) ? sanitizeDataUrl(request.url) : request.url,
        delivery_type: matchingTiming && computeResourceEntryDeliveryType(matchingTiming),
      },
      type: RumEventType.RESOURCE as const,
      _dd: {
        discarded: !configuration.trackResources,
      },
    },
    tracingInfo,
    correspondingTimingOverrides
  )

  return {
    startTime: startClocks.relative,
    duration,
    rawRumEvent: resourceEvent,
    domainContext: {
      performanceEntry: matchingTiming,
      xhr: request.xhr,
      response: request.response,
      requestInput: request.input,
      requestInit: request.init,
      error: request.error,
      isAborted: request.isAborted,
      handlingStack: request.handlingStack,
    } as RumFetchResourceEventDomainContext | RumXhrResourceEventDomainContext,
  }
}

function processResourceEntry(
  entry: RumPerformanceResourceTiming,
  configuration: RumConfiguration,
  sessionManager: RumSessionManager
): RawRumEventCollectedData<RawRumResourceEvent> | undefined {
  const startClocks = relativeToClocks(entry.startTime)
  const tracingInfo = computeResourceEntryTracingInfo(entry, configuration, sessionManager)
  if (!configuration.trackResources && !tracingInfo) {
    return
  }

  const type = computeResourceEntryType(entry)
  const entryMetrics = computeResourceEntryMetrics(entry)
  const duration = computeResourceEntryDuration(entry)

  const resourceEvent = combine(
    {
      date: startClocks.timeStamp,
      resource: {
        id: generateUUID(),
        type,
        duration: toServerDuration(duration),
        url: entry.name,
        status_code: discardZeroStatus(entry.responseStatus),
        protocol: computeResourceEntryProtocol(entry),
        delivery_type: computeResourceEntryDeliveryType(entry),
      },
      type: RumEventType.RESOURCE as const,
      _dd: {
        discarded: !configuration.trackResources,
      },
    },
    tracingInfo,
    entryMetrics
  )
  return {
    startTime: startClocks.relative,
    duration,
    rawRumEvent: resourceEvent,
    domainContext: {
      performanceEntry: entry,
    },
  }
}

function computeResourceEntryMetrics(entry: RumPerformanceResourceTiming) {
  const { renderBlockingStatus } = entry
  return {
    resource: {
      render_blocking_status: renderBlockingStatus,
      ...computeResourceEntrySize(entry),
      ...computeResourceEntryDetails(entry),
    },
  }
}

/**
 * FLASHCAT FORK - the rate reported on the event has to be the rate the decision was made under.
 * The console can change the trace rate, and a session keeps the value it was drawn with, so
 * reading it back off the init configuration would report one number while a different one was
 * used — and the backend extrapolates from this field.
 */
function effectiveRulePsr(configuration: RumConfiguration, sessionManager: RumSessionManager) {
  const drawn = sessionManager.findTrackedSession()?.drawnConfiguration
  return drawn ? drawn.traceSampleRate / 100 : configuration.rulePsr
}

function computeRequestTracingInfo(
  request: RequestCompleteEvent,
  configuration: RumConfiguration,
  sessionManager: RumSessionManager
) {
  const hasBeenTraced = request.traceSampled && request.traceId && request.spanId
  if (!hasBeenTraced) {
    return undefined
  }
  return {
    _dd: {
      span_id: request.spanId!.toString(),
      trace_id: request.traceId!.toString(),
      rule_psr: effectiveRulePsr(configuration, sessionManager),
    },
  }
}

function computeResourceEntryTracingInfo(
  entry: RumPerformanceResourceTiming,
  configuration: RumConfiguration,
  sessionManager: RumSessionManager
) {
  const hasBeenTraced = entry.traceId
  if (!hasBeenTraced) {
    return undefined
  }
  return {
    _dd: {
      trace_id: entry.traceId,
      span_id: createSpanIdentifier().toString(),
      rule_psr: effectiveRulePsr(configuration, sessionManager),
    },
  }
}

function computeRequestDuration(pageStateHistory: PageStateHistory, startClocks: ClocksState, duration: Duration) {
  return !pageStateHistory.wasInPageStateDuringPeriod(PageState.FROZEN, startClocks.relative, duration)
    ? duration
    : undefined
}

/**
 * The status is 0 for cross-origin resources without CORS headers, so the status is meaningless, and we shouldn't report it
 * https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming/responseStatus#cross-origin_response_status_codes
 */
function discardZeroStatus(statusCode: number | undefined): number | undefined {
  return statusCode === 0 ? undefined : statusCode
}
