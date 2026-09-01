import { ErrorSource } from '@flashcatcloud/browser-core'
import { RumEventType } from '../rawRumEvent.types'
import type { LifeCycle } from './lifeCycle'
import { LifeCycleEventType } from './lifeCycle'
import type { RumSessionManager } from './rumSessionManager'

/**
 * Marks the session as having reported an error, which is what releases a replay withheld by
 * `sessionReplayOnErrorSampleRate`.
 *
 * It listens after assembly rather than on the raw error, so an error discarded by `beforeSend` or
 * by a rate limiter does not release anything: a session billed for an error that cannot be found
 * afterwards would be worse than no replay at all.
 */
export function startSessionErrorTracking(lifeCycle: LifeCycle, sessionManager: RumSessionManager) {
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
    // other session would write the session store for customers who enabled neither rate - and that
    // write also pushes the session's expiry out (`processSessionStoreOperations` expands every
    // state it persists), which would move where their sessions end.
    const session = sessionManager.findTrackedSession()
    if (!session || (!session.sampledOnError && !session.sampledOnErrorReplay)) {
      return
    }
    hasReportedError = true
    sessionManager.setSessionHasError()
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
