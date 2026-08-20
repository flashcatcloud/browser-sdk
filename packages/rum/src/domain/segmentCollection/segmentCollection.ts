import type { DeflateEncoder, HttpRequest, RelativeTime, TimeoutId } from '@flashcatcloud/browser-core'
import {
  addTelemetryDebug,
  isPageExitReason,
  ONE_SECOND,
  clearTimeout,
  noop,
  relativeNow,
  setTimeout,
} from '@flashcatcloud/browser-core'
import type { LifeCycle, ViewHistory, RumSessionManager, RumConfiguration } from '@flashcatcloud/browser-rum-core'
import { LifeCycleEventType } from '@flashcatcloud/browser-rum-core'
import type { BrowserRecord, CreationReason, SegmentContext } from '../../types'
import { discardSegment } from '../replayStats'
import { buildReplayPayload } from './buildReplayPayload'
import type { FlushReason, Segment } from './segment'
import { createSegment } from './segment'

export const SEGMENT_DURATION_LIMIT = 5 * ONE_SECOND

/**
 * How much history a withheld buffer may span before it is dropped and restarted from a fresh full
 * snapshot. This bounds two things at once: the memory a session that never errors holds on to, and
 * how far back an error session can show once its buffer is released.
 */
export const BUFFER_CHECKOUT_TIME = 60 * ONE_SECOND
/**
 * beacon payload max queue size implementation is 64kb
 * ensure that we leave room for logs, rum and potential other users
 */
export let SEGMENT_BYTES_LIMIT = 60_000

// Segments are the main data structure for session replays. They contain context information used
// for indexing or UI needs, and a list of records (RRWeb 'events', renamed to avoid confusing
// namings). They are stored without any processing from the intake, and fetched one after the
// other while a session is being replayed. Their encoding (deflate) are carefully crafted to allow
// concatenating multiple segments together. Segments have a size overhead (metadata), so our goal is to
// build segments containing as many records as possible while complying with the various flush
// strategies to guarantee a good replay quality.
//
// When the recording starts, a segment is initially created.  The segment is flushed (finalized and
// sent) based on various events (non-exhaustive list):
//
// * the page visibility change or becomes to unload
// * the segment duration reaches a limit
// * the encoded segment bytes count reaches a limit
// * ...
//
// A segment cannot be created without its context.  If the RUM session ends and no session id is
// available when creating a new segment, records will be ignored, until the session is renewed and
// a new session id is available.
//
// Empty segments (segments with no record) aren't useful and should be ignored.
//
// To help investigate session replays issues, each segment is created with a "creation reason",
// indicating why the session has been created.

/**
 * Lets a session record without uploading anything until it reports an error. Sessions drawn by
 * `sessionReplayOnErrorSampleRate` record from the start, but every segment is withheld: dropped on
 * checkout while no error has happened, sent normally from the moment one has.
 */
export interface SegmentBuffering {
  /**
   * The id of the current session if it is withholding its replay, `undefined` otherwise. A segment
   * remembers this at creation, so that what happens to it later is decided by the session that
   * actually produced its records.
   */
  getWithholdingSessionId: () => string | undefined
  /**
   * Whether that same session has since reported its error. Anything else — the session expired, or
   * was renewed into a different one — means the records were never released and must be dropped:
   * uploading them would bill a session for a replay nobody asked for and nobody can explain.
   */
  isReleased: (sessionId: string) => boolean
  /** Restarts the buffer from a fresh full snapshot, after the previous one was dropped. */
  restartFromFullSnapshot: () => void
}

const NO_BUFFERING: SegmentBuffering = {
  getWithholdingSessionId: () => undefined,
  isReleased: () => false,
  restartFromFullSnapshot: noop,
}

export function startSegmentCollection(
  lifeCycle: LifeCycle,
  configuration: RumConfiguration,
  sessionManager: RumSessionManager,
  viewHistory: ViewHistory,
  httpRequest: HttpRequest,
  encoder: DeflateEncoder,
  buffering: SegmentBuffering = NO_BUFFERING
) {
  return doStartSegmentCollection(
    lifeCycle,
    () => computeSegmentContext(configuration.applicationId, sessionManager, viewHistory),
    httpRequest,
    encoder,
    buffering
  )
}

const enum SegmentCollectionStatus {
  WaitingForInitialRecord,
  SegmentPending,
  Stopped,
}
type SegmentCollectionState =
  | {
      status: SegmentCollectionStatus.WaitingForInitialRecord
      nextSegmentCreationReason: CreationReason
    }
  | {
      status: SegmentCollectionStatus.SegmentPending
      segment: Segment
      expirationTimeoutId: TimeoutId
      /** Only armed while the segment is withheld: bounds how much history the buffer may span. */
      bufferCheckoutTimeoutId: TimeoutId | undefined
      /** Set when the segment was created while its session was withholding its replay. */
      withheldForSessionId: string | undefined
    }
  | {
      status: SegmentCollectionStatus.Stopped
    }

/**
 * `buffer_checkout` is internal: it drops a withheld buffer that has grown past
 * {@link BUFFER_CHECKOUT_TIME}. It never reaches the intake, so it is mapped back to a schema value
 * where the next segment records why it was created.
 */
type InternalFlushReason = FlushReason | 'buffer_checkout'

export function doStartSegmentCollection(
  lifeCycle: LifeCycle,
  getSegmentContext: () => SegmentContext | undefined,
  httpRequest: HttpRequest,
  encoder: DeflateEncoder,
  buffering: SegmentBuffering = NO_BUFFERING
) {
  let state: SegmentCollectionState = {
    status: SegmentCollectionStatus.WaitingForInitialRecord,
    nextSegmentCreationReason: 'init',
  }

  // How many buffers were dropped before one was finally released. Without this, "the replay goes
  // back up to a minute" is a promise nobody can check.
  let droppedBufferCount = 0
  let lastBufferRestartAt: RelativeTime | undefined

  const { unsubscribe: unsubscribeViewCreated } = lifeCycle.subscribe(LifeCycleEventType.VIEW_CREATED, () => {
    flushSegment('view_change')
  })

  const { unsubscribe: unsubscribePageMayExit } = lifeCycle.subscribe(
    LifeCycleEventType.PAGE_MAY_EXIT,
    (pageMayExitEvent) => {
      flushSegment(pageMayExitEvent.reason as FlushReason)
    }
  )

  function flushSegment(flushReason: InternalFlushReason) {
    // Decided once, and against the session that produced the records rather than whatever session
    // is current now: a segment must be either dropped or sent as a whole.
    const withheldForSessionId =
      state.status === SegmentCollectionStatus.SegmentPending ? state.withheldForSessionId : undefined
    const isWithheld = withheldForSessionId !== undefined && !buffering.isReleased(withheldForSessionId)

    if (state.status === SegmentCollectionStatus.SegmentPending) {
      if (isWithheld && (flushReason === 'segment_duration_limit' || isPageExitReason(flushReason))) {
        // Nothing can be sent while withheld, so these rotations would only throw the buffer away -
        // and with it the full snapshot a released replay has to start from, leaving the rest of the
        // session as incremental records nothing can be played from. A page that is merely hidden or
        // frozen comes back and goes on recording; one that is really unloading takes the buffer with
        // it either way. Keeping it is never worse than dropping it.
        if (flushReason === 'segment_duration_limit') {
          // Re-armed, so the buffer is flushed normally within one rotation of the session erroring.
          // That rotation is also the only thing that notices the release, which leaves a window of
          // one rotation in which a session that expires right after its own error takes the buffer
          // with it. Closing it would mean asking the session manager on every record, which is far
          // too hot a path for a window this narrow.
          state.expirationTimeoutId = setTimeout(() => flushSegment('segment_duration_limit'), SEGMENT_DURATION_LIMIT)
        }
        return
      }

      state.segment.flush((metadata, encoderResult) => {
        if (isWithheld) {
          // No error was reported, so this buffer is dropped rather than sent. Rolling back its
          // stats keeps `has_replay` and the replay counters reported on view events honest.
          discardSegment(metadata.view.id, encoderResult.rawBytesCount, metadata.records_count)
          droppedBufferCount += 1
          return
        }

        if (withheldForSessionId !== undefined) {
          // The first segment released by an error: report how much history it actually carried, so
          // the window we promise can be compared against the one users get.
          addTelemetryDebug('Error session replay buffer released', {
            'buffer.duration': metadata.end - metadata.start,
            'buffer.records_count': metadata.records_count,
            'buffer.dropped_count': droppedBufferCount,
          })
          droppedBufferCount = 0
        }

        const payload = buildReplayPayload(encoderResult.output, metadata, encoderResult.rawBytesCount)

        if (isPageExitReason(flushReason)) {
          httpRequest.sendOnExit(payload)
        } else {
          httpRequest.send(payload)
        }
      })
      clearTimeout(state.expirationTimeoutId)
      clearTimeout(state.bufferCheckoutTimeoutId)
    }

    if (flushReason !== 'stop') {
      state = {
        status: SegmentCollectionStatus.WaitingForInitialRecord,
        nextSegmentCreationReason: flushReason === 'buffer_checkout' ? 'segment_duration_limit' : flushReason,
      }
    } else {
      state = {
        status: SegmentCollectionStatus.Stopped,
      }
    }

    // A dropped buffer leaves no full snapshot behind, so the next one would not be replayable on
    // its own. A view change does not need this: the new view emits its own full snapshot.
    if (isWithheld && (flushReason === 'buffer_checkout' || flushReason === 'segment_bytes_limit')) {
      // On a document whose full snapshot alone exceeds the segment limit, every restart would blow
      // the limit again straight away and restart once more. Spacing restarts out keeps that case at
      // the cost of an ordinary segment rotation instead of a hot loop.
      const now = relativeNow()
      if (lastBufferRestartAt === undefined || now - lastBufferRestartAt >= SEGMENT_DURATION_LIMIT) {
        lastBufferRestartAt = now
        buffering.restartFromFullSnapshot()
      }
    }
  }

  return {
    addRecord: (record: BrowserRecord) => {
      if (state.status === SegmentCollectionStatus.Stopped) {
        return
      }

      if (state.status === SegmentCollectionStatus.WaitingForInitialRecord) {
        const context = getSegmentContext()
        if (!context) {
          return
        }

        const withheldForSessionId = buffering.getWithholdingSessionId()
        state = {
          status: SegmentCollectionStatus.SegmentPending,
          segment: createSegment({ encoder, context, creationReason: state.nextSegmentCreationReason }),
          expirationTimeoutId: setTimeout(() => {
            flushSegment('segment_duration_limit')
          }, SEGMENT_DURATION_LIMIT),
          bufferCheckoutTimeoutId:
            withheldForSessionId !== undefined
              ? setTimeout(() => {
                  flushSegment('buffer_checkout')
                }, BUFFER_CHECKOUT_TIME)
              : undefined,
          withheldForSessionId,
        }
      }

      state.segment.addRecord(record, (encodedBytesCount) => {
        if (encodedBytesCount > SEGMENT_BYTES_LIMIT) {
          flushSegment('segment_bytes_limit')
        }
      })
    },

    stop: () => {
      flushSegment('stop')
      unsubscribeViewCreated()
      unsubscribePageMayExit()
    },
  }
}

export function computeSegmentContext(
  applicationId: string,
  sessionManager: RumSessionManager,
  viewHistory: ViewHistory
) {
  const session = sessionManager.findTrackedSession()
  const viewContext = viewHistory.findView()
  if (!session || !viewContext) {
    return undefined
  }
  return {
    application: {
      id: applicationId,
    },
    session: {
      id: session.id,
    },
    view: {
      id: viewContext.id,
    },
  }
}

export function setSegmentBytesLimit(newSegmentBytesLimit = 60_000) {
  SEGMENT_BYTES_LIMIT = newSegmentBytesLimit
}
