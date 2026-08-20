import type { Context, RelativeTime, TimeoutId } from '@flashcatcloud/browser-core'
import {
  ONE_KIBI_BYTE,
  ONE_SECOND,
  addTelemetryDebug,
  clearTimeout,
  jsonStringify,
  relativeNow,
  setTimeout,
} from '@flashcatcloud/browser-core'
import type { LifeCycle } from '../domain/lifeCycle'
import { LifeCycleEventType } from '../domain/lifeCycle'
import type { RumSessionManager } from '../domain/rumSessionManager'
import { RumEventType } from '../rawRumEvent.types'
import type { RumEvent } from '../rumEvent.types'

/**
 * How much history a withheld buffer may span. Same number as the replay side, because it is the
 * same promise to the customer: an error session shows the minute leading up to the error.
 */
export const WITHHELD_BUFFER_DURATION = 60 * ONE_SECOND

/** Memory bound. Above it the least valuable events are dropped first, see {@link EvictionTier}. */
export const WITHHELD_BUFFER_BYTES_LIMIT = 64 * ONE_KIBI_BYTE
export const WITHHELD_BUFFER_EVENTS_LIMIT = 200

/**
 * A view is the container its events hang from: the backend builds the session row out of view
 * events, so a detail released without its view would be unreachable. Views are kept out of the
 * eviction budget for that reason, and this only bounds pathological single-page navigation counts.
 */
export const WITHHELD_BUFFER_VIEWS_LIMIT = 50

/**
 * Correlated errors make every client release at the same instant, right when whatever caused them
 * is already under strain. Releases are spread over this window instead.
 */
export const WITHHELD_BUFFER_RELEASE_MAX_DELAY = 3 * ONE_SECOND

/** What gets dropped first when the buffer is over budget. Lower goes first. */
const enum EvictionTier {
  /** Long tasks, and requests that succeeded without complaint. */
  FIRST,
  /** Actions and vitals: they explain what the user was doing. */
  LAST,
  /** Errors are the reason the session is kept at all. */
  NEVER,
}

interface WithheldEvent {
  event: RumEvent & Context
  viewId: string
  time: RelativeTime
  bytes: number
  tier: EvictionTier
}

export function startWithheldEventBuffer(
  lifeCycle: LifeCycle,
  sessionManager: RumSessionManager,
  forward: (event: RumEvent & Context) => void
) {
  /** Latest event per view, in insertion order. */
  let views = new Map<string, RumEvent & Context>()
  let details: WithheldEvent[] = []
  let bytes = 0
  let withheldForSessionId: string | undefined
  let releaseTimeoutId: TimeoutId | undefined
  let droppedCount = 0

  const eventSubscription = lifeCycle.subscribe(LifeCycleEventType.RUM_EVENT_COLLECTED, (event) => {
    const session = sessionManager.findTrackedSession()

    if (session?.eventsWithheld) {
      if (withheldForSessionId !== undefined && withheldForSessionId !== session.id) {
        // A renewed session is a different session: it draws its own sampling and starts without an
        // error, so what the previous one collected must not ride along.
        discard()
      }
      withheldForSessionId = session.id
      hold(event)
      return
    }

    if (withheldForSessionId !== undefined) {
      if (session && session.id === withheldForSessionId) {
        // The session just reported its error. This event - typically the error itself - joins what
        // is held so that the whole history leaves in order, and behind the same jitter.
        hold(event)
        scheduleRelease()
        return
      }
      // The session that was withholding is gone without ever reporting an error.
      discard()
    }

    forward(event)
  })

  // Whatever is still held when the page goes away belongs to a session that never reported an
  // error, so it is dropped rather than sent. A release already scheduled is sent immediately
  // instead of losing it to the jitter window.
  const pageMayExitSubscription = lifeCycle.subscribe(LifeCycleEventType.PAGE_MAY_EXIT, () => {
    if (releaseTimeoutId !== undefined) {
      release()
    } else {
      discard()
    }
  })

  function hold(event: RumEvent & Context) {
    if (event.type === RumEventType.VIEW) {
      // Upsert: a view event is cumulative, so the latest one supersedes the ones before it. This
      // mirrors what the batch already does with view events.
      views.delete(event.view.id)
      views.set(event.view.id, event)
      while (views.size > WITHHELD_BUFFER_VIEWS_LIMIT) {
        views.delete(views.keys().next().value!)
      }
      return
    }

    const serialized = jsonStringify(event)
    details.push({
      event,
      viewId: event.view.id,
      time: relativeNow(),
      bytes: serialized ? serialized.length : 0,
      tier: getEvictionTier(event),
    })
    bytes += details[details.length - 1].bytes

    prune()
    while (details.length > WITHHELD_BUFFER_EVENTS_LIMIT || bytes > WITHHELD_BUFFER_BYTES_LIMIT) {
      if (!evictOne()) {
        break
      }
    }
  }

  /** Drops what has aged out of the window, so the span kept is the one we promise. */
  function prune() {
    const oldestAllowed = (relativeNow() - WITHHELD_BUFFER_DURATION) as RelativeTime
    let cutoff = 0
    while (cutoff < details.length && details[cutoff].time < oldestAllowed) {
      bytes -= details[cutoff].bytes
      droppedCount += 1
      cutoff += 1
    }
    if (cutoff > 0) {
      details = details.slice(cutoff)
    }
  }

  /** Removes the oldest event of the least valuable tier present. Returns false when empty. */
  function evictOne() {
    for (const tier of [EvictionTier.FIRST, EvictionTier.LAST, EvictionTier.NEVER]) {
      const index = details.findIndex((held) => held.tier === tier)
      if (index !== -1) {
        bytes -= details[index].bytes
        droppedCount += 1
        details.splice(index, 1)
        return true
      }
    }
    return false
  }

  function scheduleRelease() {
    if (releaseTimeoutId !== undefined) {
      return
    }
    releaseTimeoutId = setTimeout(release, computeReleaseDelay(withheldForSessionId!))
  }

  function release() {
    clearTimeout(releaseTimeoutId)
    releaseTimeoutId = undefined
    prune()

    // A detail whose view is gone has no container to hang from, so it would be unreachable.
    const releasable = details.filter((held) => views.has(held.viewId))
    const detailSampledFrom = releasable.length > 0 ? releasable[0].event.date : undefined

    views.forEach((view) => {
      // `sampled_for_error` is stamped at assembly for every view of the session; only the point the
      // detail actually reaches back to is known here.
      if (detailSampledFrom !== undefined) {
        view.session.detail_sampled_from = detailSampledFrom
      }
      forward(view)
    })
    releasable.forEach((held) => forward(held.event))

    addTelemetryDebug('Error session event buffer released', {
      'buffer.views_count': views.size,
      'buffer.events_count': releasable.length,
      'buffer.dropped_count': droppedCount,
      'buffer.bytes': bytes,
    })

    reset()
  }

  function discard() {
    clearTimeout(releaseTimeoutId)
    releaseTimeoutId = undefined
    reset()
  }

  function reset() {
    views = new Map()
    details = []
    bytes = 0
    droppedCount = 0
    withheldForSessionId = undefined
  }

  return {
    stop: () => {
      discard()
      eventSubscription.unsubscribe()
      pageMayExitSubscription.unsubscribe()
    },
  }
}

function getEvictionTier(event: RumEvent): EvictionTier {
  switch (event.type) {
    case RumEventType.ERROR:
      return EvictionTier.NEVER
    case RumEventType.LONG_TASK:
      return EvictionTier.FIRST
    case RumEventType.RESOURCE: {
      // A request that failed is part of how the error happened; one that succeeded rarely is.
      const statusCode = event.resource?.status_code
      return statusCode === 0 || (statusCode !== undefined && statusCode >= 400)
        ? EvictionTier.LAST
        : EvictionTier.FIRST
    }
    default:
      return EvictionTier.LAST
  }
}

/** Deterministic per session, so a client always spreads to the same offset. */
export function computeReleaseDelay(sessionId: string) {
  let hash = 0
  for (let i = 0; i < sessionId.length; i += 1) {
    hash = (hash + sessionId.charCodeAt(i)) % WITHHELD_BUFFER_RELEASE_MAX_DELAY
  }
  return hash
}
