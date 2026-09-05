import type { RelativeTime, TrackingConsentState } from '@flashcatcloud/browser-core'
import {
  BridgeCapability,
  Observable,
  bridgeSupports,
  noop,
  performDraw,
  startSessionManager,
} from '@flashcatcloud/browser-core'
import type { RumConfiguration } from './configuration'
import type { LifeCycle } from './lifeCycle'
import { LifeCycleEventType } from './lifeCycle'

export const enum SessionType {
  SYNTHETICS = 'synthetics',
  USER = 'user',
  CI_TEST = 'ci_test',
}

export const RUM_SESSION_KEY = 'rum'

export interface RumSessionManager {
  findTrackedSession: (startTime?: RelativeTime) => RumSession | undefined
  expire: () => void
  expireObservable: Observable<void>
  setForcedReplay: () => void
  /**
   * Marks the given session as having reported an error. For a session sampled by
   * `sessionReplayOnError`, this is what releases the withheld replay. The id is required
   * because the store write can be deferred by the lock, and it must not land on a later session.
   */
  setSessionHasError: (sessionId: string) => void
}

export type RumSession = {
  id: string
  sessionReplay: SessionReplayState
  /**
   * Whether the session collects events but withholds them until it reports an error. Nothing is
   * uploaded while this is true, and if the session never errors nothing ever is.
   */
  eventsWithheld: boolean
  /**
   * Whether the session is only kept because of `sessionOnError`. Unlike {@link eventsWithheld} this
   * stays true once the error has been reported, so what is stored can be told apart from a plainly
   * sampled session - its detail only starts where the buffer reached.
   */
  sampledOnError: boolean
  /**
   * Whether the replay of this session is only kept if it reports an error. Same idea as
   * {@link sampledOnError}, for the replay rather than the events.
   */
  sampledOnErrorReplay: boolean
  anonymousId?: string
}

export const enum RumTrackingType {
  NOT_TRACKED = '0',
  TRACKED_WITH_SESSION_REPLAY = '1',
  TRACKED_WITHOUT_SESSION_REPLAY = '2',
  TRACKED_WITH_ERROR_SESSION_REPLAY = '3',
  TRACKED_ON_ERROR_WITHOUT_SESSION_REPLAY = '4',
  TRACKED_ON_ERROR_WITH_SESSION_REPLAY = '5',
}

export const enum SessionReplayState {
  OFF,
  SAMPLED,
  FORCED,
  /**
   * The session records, but every segment is withheld until it reports its first error. If no error
   * ever happens, nothing is uploaded and the session is never billed. Once an error is reported the
   * session moves to `SAMPLED` and the withheld buffer is released.
   */
  BUFFERED_ON_ERROR,
}

export function startRumSessionManager(
  configuration: RumConfiguration,
  lifeCycle: LifeCycle,
  trackingConsentState: TrackingConsentState
): RumSessionManager {
  const sessionManager = startSessionManager(
    configuration,
    RUM_SESSION_KEY,
    (rawTrackingType) => computeSessionState(configuration, rawTrackingType),
    trackingConsentState
  )

  sessionManager.expireObservable.subscribe(() => {
    lifeCycle.notify(LifeCycleEventType.SESSION_EXPIRED)
  })

  sessionManager.renewObservable.subscribe(() => {
    lifeCycle.notify(LifeCycleEventType.SESSION_RENEWED)
  })

  sessionManager.sessionStateUpdateObservable.subscribe(({ previousState, newState }) => {
    if (!previousState.forcedReplay && newState.forcedReplay) {
      const sessionEntity = sessionManager.findSession()
      if (sessionEntity) {
        sessionEntity.isReplayForced = true
      }
    }
    if (!previousState.hasError && newState.hasError) {
      const sessionEntity = sessionManager.findSession()
      if (sessionEntity) {
        sessionEntity.hasError = true
      }
    }
  })
  return {
    findTrackedSession: (startTime) => {
      const session = sessionManager.findSession(startTime)
      if (!session || !isTypeTracked(session.trackingType)) {
        return
      }
      return {
        id: session.id,
        sessionReplay: computeSessionReplayState(session.trackingType, session.hasError, session.isReplayForced),
        eventsWithheld: computeEventsWithheld(session.trackingType, session.hasError, session.isReplayForced),
        sampledOnError: withholdsEvents(session.trackingType),
        sampledOnErrorReplay: withholdsReplay(session.trackingType),
        anonymousId: session.anonymousId,
      }
    },
    expire: sessionManager.expire,
    expireObservable: sessionManager.expireObservable,
    setForcedReplay: () => sessionManager.updateSessionState(() => ({ forcedReplay: '1' })),
    setSessionHasError: (sessionId) => {
      const sessionEntity = sessionManager.findSession()
      if (sessionEntity?.id === sessionId) {
        // Marked in memory straight away, and not only once the store write lands: that write goes
        // through a lock that can defer it by several retries, and until then the withheld buffer
        // would still read the session as withholding - so an error followed closely by the page or
        // the session ending would throw away the very buffer the error was meant to release.
        sessionEntity.hasError = true
      }
      sessionManager.updateSessionState((state) => (state.id === sessionId ? { hasError: '1' } : undefined))
    },
  }
}

export function withholdsReplay(trackingType: RumTrackingType) {
  return (
    trackingType === RumTrackingType.TRACKED_WITH_ERROR_SESSION_REPLAY ||
    trackingType === RumTrackingType.TRACKED_ON_ERROR_WITH_SESSION_REPLAY
  )
}

export function withholdsEvents(trackingType: RumTrackingType) {
  return (
    trackingType === RumTrackingType.TRACKED_ON_ERROR_WITHOUT_SESSION_REPLAY ||
    trackingType === RumTrackingType.TRACKED_ON_ERROR_WITH_SESSION_REPLAY
  )
}

export function computeSessionReplayState(
  trackingType: RumTrackingType,
  hasError: boolean,
  isReplayForced: boolean
): SessionReplayState {
  if (trackingType === RumTrackingType.TRACKED_WITH_SESSION_REPLAY) {
    return SessionReplayState.SAMPLED
  }
  if (withholdsReplay(trackingType) && hasError) {
    return SessionReplayState.SAMPLED
  }
  // A forced replay wins over withholding: the host explicitly asked for this user's replay, so it
  // must not keep waiting for an error that may never come.
  if (isReplayForced) {
    return SessionReplayState.FORCED
  }
  if (withholdsReplay(trackingType)) {
    return SessionReplayState.BUFFERED_ON_ERROR
  }
  return SessionReplayState.OFF
}

export function computeEventsWithheld(
  trackingType: RumTrackingType,
  hasError: boolean,
  isReplayForced: boolean
): boolean {
  // Forcing capture asks for this user's whole session, so it releases the events too - otherwise
  // the forced replay would be uploaded for a session that does not exist yet.
  if (hasError || isReplayForced) {
    return false
  }
  return withholdsEvents(trackingType)
}

/**
 * Start a tracked replay session stub
 */
export function startRumSessionManagerStub(): RumSessionManager {
  const session: RumSession = {
    id: '00000000-aaaa-0000-aaaa-000000000000',
    sessionReplay: bridgeSupports(BridgeCapability.RECORDS) ? SessionReplayState.SAMPLED : SessionReplayState.OFF,
    eventsWithheld: false,
    sampledOnError: false,
    sampledOnErrorReplay: false,
  }
  return {
    findTrackedSession: () => session,
    expire: noop,
    expireObservable: new Observable(),
    setForcedReplay: noop,
    setSessionHasError: noop,
  }
}

function computeSessionState(configuration: RumConfiguration, rawTrackingType?: string) {
  let trackingType: RumTrackingType
  if (hasValidRumSession(rawTrackingType)) {
    trackingType = rawTrackingType
  } else if (performDraw(configuration.sessionSampleRate)) {
    if (performDraw(configuration.sessionReplaySampleRate)) {
      trackingType = RumTrackingType.TRACKED_WITH_SESSION_REPLAY
    } else if (configuration.sessionReplayOnError) {
      // Only for sessions the plain replay draw missed, so a session is never counted by both.
      trackingType = RumTrackingType.TRACKED_WITH_ERROR_SESSION_REPLAY
    } else {
      trackingType = RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY
    }
  } else if (configuration.sessionOnError) {
    // Only for sessions the plain session draw missed, so a session is never counted by both.
    // Such a session never uploads its replay ahead of its events: whichever replay rate it draws,
    // the replay is withheld alongside them, because until they are released the session does not
    // exist yet and a replay sent then would have nothing to attach to.
    trackingType =
      performDraw(configuration.sessionReplaySampleRate) || configuration.sessionReplayOnError
        ? RumTrackingType.TRACKED_ON_ERROR_WITH_SESSION_REPLAY
        : RumTrackingType.TRACKED_ON_ERROR_WITHOUT_SESSION_REPLAY
  } else {
    trackingType = RumTrackingType.NOT_TRACKED
  }
  return {
    trackingType,
    isTracked: isTypeTracked(trackingType),
  }
}

function hasValidRumSession(trackingType?: string): trackingType is RumTrackingType {
  return (
    trackingType === RumTrackingType.NOT_TRACKED ||
    trackingType === RumTrackingType.TRACKED_WITH_SESSION_REPLAY ||
    trackingType === RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY ||
    trackingType === RumTrackingType.TRACKED_WITH_ERROR_SESSION_REPLAY ||
    trackingType === RumTrackingType.TRACKED_ON_ERROR_WITHOUT_SESSION_REPLAY ||
    trackingType === RumTrackingType.TRACKED_ON_ERROR_WITH_SESSION_REPLAY
  )
}

function isTypeTracked(rumSessionType: RumTrackingType | undefined) {
  return (
    rumSessionType === RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY ||
    rumSessionType === RumTrackingType.TRACKED_WITH_SESSION_REPLAY ||
    rumSessionType === RumTrackingType.TRACKED_WITH_ERROR_SESSION_REPLAY ||
    rumSessionType === RumTrackingType.TRACKED_ON_ERROR_WITHOUT_SESSION_REPLAY ||
    rumSessionType === RumTrackingType.TRACKED_ON_ERROR_WITH_SESSION_REPLAY
  )
}
