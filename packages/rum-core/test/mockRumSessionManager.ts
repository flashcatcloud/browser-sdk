import { Observable } from '@flashcatcloud/browser-core'
import {
  RumTrackingType,
  computeEventsWithheld,
  computeSessionReplayState,
  withholdsEvents,
  withholdsReplay,
  type RumSessionManager,
} from '../src/domain/rumSessionManager'

export interface RumSessionManagerMock extends RumSessionManager {
  setId(id: string): RumSessionManagerMock
  setNotTracked(): RumSessionManagerMock
  setTrackedWithoutSessionReplay(): RumSessionManagerMock
  setTrackedWithSessionReplay(): RumSessionManagerMock
  setTrackedWithErrorSessionReplay(): RumSessionManagerMock
  setTrackedOnError(): RumSessionManagerMock
  setTrackedOnErrorWithSessionReplay(): RumSessionManagerMock
  setForcedReplay(): RumSessionManagerMock
  setSessionHasError(): RumSessionManagerMock
}

const DEFAULT_ID = 'session-id'
const enum SessionStatus {
  TRACKED_WITH_SESSION_REPLAY,
  TRACKED_WITHOUT_SESSION_REPLAY,
  TRACKED_WITH_ERROR_SESSION_REPLAY,
  TRACKED_ON_ERROR,
  TRACKED_ON_ERROR_WITH_SESSION_REPLAY,
  NOT_TRACKED,
  EXPIRED,
}

const TRACKING_TYPES: { [key in SessionStatus]?: RumTrackingType } = {
  [SessionStatus.TRACKED_WITH_SESSION_REPLAY]: RumTrackingType.TRACKED_WITH_SESSION_REPLAY,
  [SessionStatus.TRACKED_WITHOUT_SESSION_REPLAY]: RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY,
  [SessionStatus.TRACKED_WITH_ERROR_SESSION_REPLAY]: RumTrackingType.TRACKED_WITH_ERROR_SESSION_REPLAY,
  [SessionStatus.TRACKED_ON_ERROR]: RumTrackingType.TRACKED_ON_ERROR_WITHOUT_SESSION_REPLAY,
  [SessionStatus.TRACKED_ON_ERROR_WITH_SESSION_REPLAY]: RumTrackingType.TRACKED_ON_ERROR_WITH_SESSION_REPLAY,
}

export function createRumSessionManagerMock(): RumSessionManagerMock {
  let id = DEFAULT_ID
  let sessionStatus: SessionStatus = SessionStatus.TRACKED_WITH_SESSION_REPLAY
  let forcedReplay: boolean = false
  let hasError: boolean = false
  return {
    findTrackedSession() {
      const trackingType = TRACKING_TYPES[sessionStatus]
      if (!trackingType) {
        return undefined
      }
      return {
        id,
        // Derived the same way as in production, so the mock cannot drift from the real state machine
        sessionReplay: computeSessionReplayState(trackingType, hasError, forcedReplay),
        eventsWithheld: computeEventsWithheld(trackingType, hasError, forcedReplay),
        sampledOnError: withholdsEvents(trackingType),
        sampledOnErrorReplay: withholdsReplay(trackingType),
        anonymousId: 'device-123',
      }
    },
    expire() {
      sessionStatus = SessionStatus.EXPIRED
      this.expireObservable.notify()
    },
    expireObservable: new Observable(),
    setId(newId) {
      id = newId
      return this
    },
    setNotTracked() {
      sessionStatus = SessionStatus.NOT_TRACKED
      return this
    },
    setTrackedWithoutSessionReplay() {
      sessionStatus = SessionStatus.TRACKED_WITHOUT_SESSION_REPLAY
      return this
    },
    setTrackedWithSessionReplay() {
      sessionStatus = SessionStatus.TRACKED_WITH_SESSION_REPLAY
      return this
    },
    setTrackedWithErrorSessionReplay() {
      sessionStatus = SessionStatus.TRACKED_WITH_ERROR_SESSION_REPLAY
      return this
    },
    setTrackedOnError() {
      sessionStatus = SessionStatus.TRACKED_ON_ERROR
      return this
    },
    setTrackedOnErrorWithSessionReplay() {
      sessionStatus = SessionStatus.TRACKED_ON_ERROR_WITH_SESSION_REPLAY
      return this
    },
    setForcedReplay() {
      forcedReplay = true
      return this
    },
    setSessionHasError() {
      hasError = true
      return this
    },
  }
}
