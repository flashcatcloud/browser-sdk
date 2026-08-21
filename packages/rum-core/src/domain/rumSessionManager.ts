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
   * Marks the session as having reported an error. For a session sampled by
   * `sessionReplayOnErrorSampleRate`, this is what releases the withheld replay.
   */
  setSessionHasError: () => void
}

export type RumSession = {
  id: string
  sessionReplay: SessionReplayState
  /**
   * Whether the replay of this session is only kept if it reports an error. Unlike
   * {@link sessionReplay} this stays true once the error has been reported, so a replay collected
   * that way can be told apart from one collected unconditionally.
   */
  sampledOnErrorReplay: boolean
  anonymousId?: string
}

export const enum RumTrackingType {
  NOT_TRACKED = '0',
  TRACKED_WITH_SESSION_REPLAY = '1',
  TRACKED_WITHOUT_SESSION_REPLAY = '2',
  TRACKED_WITH_ERROR_SESSION_REPLAY = '3',
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
        sampledOnErrorReplay: withholdsReplay(session.trackingType),
        anonymousId: session.anonymousId,
      }
    },
    expire: sessionManager.expire,
    expireObservable: sessionManager.expireObservable,
    setForcedReplay: () => sessionManager.updateSessionState({ forcedReplay: '1' }),
    setSessionHasError: () => sessionManager.updateSessionState({ hasError: '1' }),
  }
}

export function withholdsReplay(trackingType: RumTrackingType) {
  return trackingType === RumTrackingType.TRACKED_WITH_ERROR_SESSION_REPLAY
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

/**
 * Start a tracked replay session stub
 */
export function startRumSessionManagerStub(): RumSessionManager {
  const session: RumSession = {
    id: '00000000-aaaa-0000-aaaa-000000000000',
    sessionReplay: bridgeSupports(BridgeCapability.RECORDS) ? SessionReplayState.SAMPLED : SessionReplayState.OFF,
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
  } else if (!performDraw(configuration.sessionSampleRate)) {
    trackingType = RumTrackingType.NOT_TRACKED
  } else if (performDraw(configuration.sessionReplaySampleRate)) {
    trackingType = RumTrackingType.TRACKED_WITH_SESSION_REPLAY
  } else if (performDraw(configuration.sessionReplayOnErrorSampleRate)) {
    // Drawn only when the plain replay draw missed, so a session is never counted by both rates.
    trackingType = RumTrackingType.TRACKED_WITH_ERROR_SESSION_REPLAY
  } else {
    trackingType = RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY
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
    trackingType === RumTrackingType.TRACKED_WITH_ERROR_SESSION_REPLAY
  )
}

function isTypeTracked(rumSessionType: RumTrackingType | undefined) {
  return (
    rumSessionType === RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY ||
    rumSessionType === RumTrackingType.TRACKED_WITH_SESSION_REPLAY ||
    rumSessionType === RumTrackingType.TRACKED_WITH_ERROR_SESSION_REPLAY
  )
}
