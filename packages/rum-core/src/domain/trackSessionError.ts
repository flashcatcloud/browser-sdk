import { ErrorSource } from '@flashcatcloud/browser-core'
import type { RecorderApi } from '../boot/rumPublicApi'
import { RumEventType } from '../rawRumEvent.types'
import type { LifeCycle } from './lifeCycle'
import { LifeCycleEventType } from './lifeCycle'
import { SessionReplayState } from './rumSessionManager'
import type { RumSessionManager } from './rumSessionManager'

/**
 * Marks the session as having reported an error, which is what releases what an on-error session
 * withheld: a replay withheld by `sessionReplayOnError`, and the events withheld by `sessionOnError`.
 *
 * It listens after assembly rather than on the raw error, so an error discarded by `beforeSend` or
 * by a rate limiter does not release anything: a session billed for an error that cannot be found
 * afterwards would be worse than no replay at all.
 */
export function startSessionErrorTracking(
  lifeCycle: LifeCycle,
  sessionManager: RumSessionManager,
  recorderApi: RecorderApi
) {
  let hasReportedError = false

  const eventSubscription = lifeCycle.subscribe(LifeCycleEventType.RUM_EVENT_COLLECTED, (event) => {
    if (hasReportedError || event.type !== RumEventType.ERROR) {
      return
    }
    // The SDK's own failures — an intake request that could not be sent, for instance — are ours,
    // not the application's. Counting them would turn every session into an error session for any
    // customer whose network blocks our endpoint, billing them for replays of nothing.
    if (event.error.source === ErrorSource.AGENT) {
      return
    }
    // Only a session that is withholding something has any use for this mark. Setting it on any
    // other session would write the session store for customers who enabled neither switch - and that
    // write also pushes the session's expiry out (`processSessionStoreOperations` expands every
    // state it persists), which would move where their sessions end.
    const session = sessionManager.findTrackedSession()
    if (!session || event.session?.id !== session.id || (!session.sampledOnError && !session.sampledOnErrorReplay)) {
      return
    }
    // The error was assembled while its replay was still withheld, so it could not claim one then -
    // see sessionContext. It is the event the replay is released for and the one the console opens
    // the replay from, so it claims it here, before the batch (which subscribes after this) takes it.
    if (session.sessionReplay === SessionReplayState.BUFFERED_ON_ERROR && recorderApi.isRecording()) {
      ;(event.session as { has_replay?: boolean }).has_replay = true
    }
    hasReportedError = true
    sessionManager.setSessionHasError(session.id)
  })

  // A renewed session is a different session: it draws its own sampling and starts out without an
  // error, so anything withheld for it must stay withheld until it reports one of its own.
  const renewSubscription = lifeCycle.subscribe(LifeCycleEventType.SESSION_RENEWED, () => {
    hasReportedError = false
  })

  return {
    stop: () => {
      eventSubscription.unsubscribe()
      renewSubscription.unsubscribe()
    },
  }
}
