import type { Context, RelativeTime, TimeoutId } from '@flashcatcloud/browser-core'
import {
  ONE_KIBI_BYTE,
  ONE_SECOND,
  addTelemetryDebug,
  clearTimeout,
  computeBytesCount,
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
const WITHHELD_BUFFER_BYTES_LIMIT = 64 * ONE_KIBI_BYTE
export const WITHHELD_BUFFER_EVENTS_LIMIT = 200

/**
 * A view is the container its events hang from: the backend builds the session row out of view
 * events, so a detail released without its view would be unreachable. Views are kept out of the
 * eviction budget for that reason, and this only bounds pathological single-page navigation counts.
 */
const WITHHELD_BUFFER_VIEWS_LIMIT = 50

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
  /**
   * Errors are the reason the session is kept at all, so they go only once nothing else is left -
   * and even then the newest goes first, because the earliest error is the one that releases the
   * buffer and the one the session is about.
   */
  LAST_RESORT,
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
  let currentViewId: string | undefined
  let currentViewDate = -Infinity
  let withheldForSessionId: string | undefined
  /** The last session whose buffer was thrown away, so its stragglers are thrown away too. */
  let discardedSessionId: string | undefined
  let releaseTimeoutId: TimeoutId | undefined
  let droppedCount = 0

  const eventSubscription = lifeCycle.subscribe(LifeCycleEventType.RUM_EVENT_COLLECTED, (event) => {
    const session = sessionManager.findTrackedSession()
    // Which session an event belongs to is what the event says, not whichever session is current:
    // assembly resolves the session at the event's own start time, so a request or a view update
    // that finishes after its session ended still carries that session's id. An event that does not
    // say is treated as the current one's, which is how it was handled before there was a buffer.
    const eventSessionId = event.session?.id
    const isFrom = (sessionId: string | undefined) => eventSessionId === undefined || eventSessionId === sessionId

    if (eventSessionId !== undefined && eventSessionId === discardedSessionId) {
      // Its session ended without ever reporting an error and everything held for it was thrown
      // away. Letting a straggler through would store the very session the withholding avoided.
      return
    }

    if (session?.eventsWithheld && isFrom(session.id)) {
      if (withheldForSessionId !== undefined && withheldForSessionId !== session.id) {
        // A renewed session is a different session: it draws its own sampling and starts without an
        // error, so what the previous one collected must not ride along.
        discardBuffer()
      }
      withheldForSessionId = session.id
      hold(event)
      return
    }

    if (withheldForSessionId !== undefined && isFrom(withheldForSessionId)) {
      if (session && session.id === withheldForSessionId) {
        // The session just reported its error. This event - typically the error itself - joins what
        // is held so that the whole history leaves in order, and behind the same jitter.
        hold(event)
        scheduleRelease()
        return
      }
      // The session that was withholding is gone without ever reporting an error, and this event is
      // one of its own, so it goes the same way as everything held for it.
      discardBuffer()
      return
    }

    forward(event)
  })

  /**
   * Called when what is held may not get another chance to leave: the page is going away, or the
   * session ended (which is also how a withdrawn tracking consent arrives here).
   *
   * `discardIfUnreleased` says whether the buffer has anything left to wait for. A session that
   * ended is over, so what it never released goes no further. A page being hidden is not: it comes
   * back, and dropping the minute it had collected would leave the error that follows with nothing.
   */
  function settleBuffer(discardIfUnreleased: boolean) {
    if (withheldForSessionId === undefined) {
      return
    }
    // A release already scheduled goes out now rather than being lost to the jitter window. The
    // session is also re-read, because it may have reported its error without the buffer noticing:
    // the event arrives synchronously but the state behind it is written through a lock that can
    // defer the write, and "an error, then the user leaves" is exactly what this feature is for.
    const session = sessionManager.findTrackedSession()
    const hasSinceErrored = !!session && session.id === withheldForSessionId && !session.eventsWithheld

    if (releaseTimeoutId !== undefined || hasSinceErrored) {
      release()
    } else if (discardIfUnreleased) {
      discardBuffer()
    }
  }

  // Kept on a page exit: switching tabs raises one and the page comes straight back, while a page
  // that is really unloading takes the buffer with it either way - so there is nothing to gain by
  // dropping it, and a minute of history to lose. The replay side reasons the same way.
  const pageMayExitSubscription = lifeCycle.subscribe(LifeCycleEventType.PAGE_MAY_EXIT, () => settleBuffer(false))
  const sessionExpireSubscription = lifeCycle.subscribe(LifeCycleEventType.SESSION_EXPIRED, () => settleBuffer(true))

  function hold(event: RumEvent & Context) {
    if (event.type === RumEventType.VIEW) {
      // Upsert: a view event is cumulative, so the latest one supersedes the ones before it. This
      // mirrors what the batch already does with view events. The delete is deliberate - setting an
      // existing key leaves its insertion order untouched, so without it the oldest entry would be
      // the first view seen rather than the least recently updated one.
      views.delete(event.view.id)
      views.set(event.view.id, event)
      // A view event carries its view's start date, so a late update of a view that already ended
      // does not make it current again. Letting it would have `prune` drop the view the next error
      // hangs from, and the release would then filter that error out of its own buffer.
      if (event.date >= currentViewDate) {
        currentViewDate = event.date
        currentViewId = event.view.id
      }
      while (views.size > WITHHELD_BUFFER_VIEWS_LIMIT) {
        views.delete(views.keys().next().value!)
      }
      prune()
      return
    }

    const held: WithheldEvent = {
      event,
      viewId: event.view.id,
      time: relativeNow(),
      bytes: computeBytesCount(jsonStringify(event) ?? ''),
      tier: getEvictionTier(event),
    }
    details.push(held)
    bytes += held.bytes

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

    // A view is kept as the container of the detail hanging from it, so once none of its detail is
    // left inside the window it has nothing left to contain. Without this the map would grow with
    // every route change for as long as the page lives, holding more than the detail budget itself.
    // The view in progress always stays: it is the container the error will hang from.
    const viewsWithDetail = new Set(details.map((held) => held.viewId))
    views.forEach((_, viewId) => {
      if (viewId !== currentViewId && !viewsWithDetail.has(viewId)) {
        views.delete(viewId)
      }
    })
  }

  /** Removes one event of the least valuable tier present. Returns false when there is none left. */
  function evictOne() {
    for (const tier of [EvictionTier.FIRST, EvictionTier.LAST]) {
      const index = details.findIndex((held) => held.tier === tier)
      if (index !== -1) {
        evictAt(index)
        return true
      }
    }

    // Only errors are left. One still has to go to stay within budget, and it is the newest: an
    // error storm would otherwise push out the first error, which is the one that released the
    // buffer and the one the session is really about.
    for (let index = details.length - 1; index >= 0; index -= 1) {
      if (details[index].tier === EvictionTier.LAST_RESORT) {
        evictAt(index)
        return true
      }
    }
    return false
  }

  function evictAt(index: number) {
    bytes -= details[index].bytes
    droppedCount += 1
    details.splice(index, 1)
  }

  function scheduleRelease() {
    if (releaseTimeoutId !== undefined) {
      return
    }
    releaseTimeoutId = setTimeout(release, computeReleaseDelay(withheldForSessionId!))
  }

  function release() {
    prune()

    // A detail whose view is gone has no container to hang from, so it would be unreachable.
    const releasable = details.filter((held) => views.has(held.viewId))
    const detailSampledFrom = releasable.length > 0 ? releasable[0].event.date : undefined

    if (detailSampledFrom !== undefined) {
      // Recorded on the session so that every view update from here on carries it - the batch
      // upserts views by id, so the next ordinary update would otherwise replace these ones before
      // the batch is ever sent. These were assembled too early to pick it up, so they are given the
      // same value directly, which is what the backend sees if the page goes before the next update.
      sessionManager.setSessionDetailSampledFrom(detailSampledFrom)
    }

    views.forEach((view) => {
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

    clearBuffer()
  }

  /** Throws the buffer away, and remembers whose it was so its stragglers go the same way. */
  function discardBuffer() {
    discardedSessionId = withheldForSessionId
    clearBuffer()
  }

  /** Empties the buffer, whether it was just released or is being thrown away. */
  function clearBuffer() {
    clearTimeout(releaseTimeoutId)
    releaseTimeoutId = undefined
    views = new Map()
    details = []
    bytes = 0
    droppedCount = 0
    currentViewId = undefined
    currentViewDate = -Infinity
    withheldForSessionId = undefined
  }

  return {
    stop: () => {
      clearBuffer()
      eventSubscription.unsubscribe()
      pageMayExitSubscription.unsubscribe()
      sessionExpireSubscription.unsubscribe()
    },
  }
}

function getEvictionTier(event: RumEvent): EvictionTier {
  switch (event.type) {
    case RumEventType.ERROR:
      return EvictionTier.LAST_RESORT
    case RumEventType.LONG_TASK:
      return EvictionTier.FIRST
    case RumEventType.RESOURCE: {
      // A request that failed is part of how the error happened; one that succeeded rarely is.
      // -1 stands for an unknown status code, which is treated like an ordinary success
      const statusCode = event.resource?.status_code ?? -1
      return statusCode === 0 || statusCode >= 400 ? EvictionTier.LAST : EvictionTier.FIRST
    }
    default:
      return EvictionTier.LAST
  }
}

/** Keeps the running hash inside the range `Math.imul` is exact over. */
const LARGEST_INT32_PRIME = 2147483647

/**
 * Deterministic per session, so a client always spreads to the same offset.
 *
 * Multiplicative rather than a running sum: session ids are same-length strings drawn from the same
 * small alphabet, so summing their character codes lands almost every session within a few hundred
 * milliseconds of the same value - which delays the herd instead of spreading it.
 */
export function computeReleaseDelay(sessionId: string) {
  let hash = 0
  for (let i = 0; i < sessionId.length; i += 1) {
    hash = (Math.imul(hash, 31) + sessionId.charCodeAt(i)) % LARGEST_INT32_PRIME
  }
  return Math.abs(hash) % WITHHELD_BUFFER_RELEASE_MAX_DELAY
}
