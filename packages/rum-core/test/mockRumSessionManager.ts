import { Observable } from '@flashcatcloud/browser-core'
import { SessionReplayState, type DrawnConfiguration, type RumSessionManager } from '../src/domain/rumSessionManager'

export interface RumSessionManagerMock extends RumSessionManager {
  setId(id: string): RumSessionManagerMock
  setNotTracked(): RumSessionManagerMock
  setTrackedWithoutSessionReplay(): RumSessionManagerMock
  setTrackedWithSessionReplay(): RumSessionManagerMock
  setForcedReplay(): RumSessionManagerMock
  setDrawnConfiguration(drawn: DrawnConfiguration): RumSessionManagerMock
}

const DEFAULT_ID = 'session-id'
const enum SessionStatus {
  TRACKED_WITH_SESSION_REPLAY,
  TRACKED_WITHOUT_SESSION_REPLAY,
  NOT_TRACKED,
  EXPIRED,
}

export function createRumSessionManagerMock(): RumSessionManagerMock {
  let id = DEFAULT_ID
  let sessionStatus: SessionStatus = SessionStatus.TRACKED_WITH_SESSION_REPLAY
  let forcedReplay: boolean = false
  let drawnConfiguration: DrawnConfiguration | undefined
  return {
    findTrackedSession() {
      if (
        sessionStatus !== SessionStatus.TRACKED_WITH_SESSION_REPLAY &&
        sessionStatus !== SessionStatus.TRACKED_WITHOUT_SESSION_REPLAY
      ) {
        return undefined
      }
      return {
        id,
        sessionReplay:
          sessionStatus === SessionStatus.TRACKED_WITH_SESSION_REPLAY
            ? SessionReplayState.SAMPLED
            : forcedReplay
              ? SessionReplayState.FORCED
              : SessionReplayState.OFF,
        anonymousId: 'device-123',
        drawnConfiguration,
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
    setForcedReplay() {
      forcedReplay = true
      return this
    },
    setDrawnConfiguration(drawn) {
      drawnConfiguration = drawn
      return this
    },
    // A deliberate simplification, and one to keep in mind when asserting against it. The real
    // manager cannot collect a visitor on the spot: a session that was not being collected has to
    // end and be drawn again at the next user interaction, and it comes back with a NEW id. And a
    // session collected WITHOUT replay keeps its tracking type and only gains forced replay, so it
    // reports `FORCED` where this reports `SAMPLED` — which is what `sampled_for_replay` on the
    // events is derived from. Only a session already collected WITH replay behaves as it does
    // here; a consumer test must not conclude from this mock that collection starts immediately,
    // that the id survives, or that replay reads as sampled.
    setForcedSession() {
      sessionStatus = SessionStatus.TRACKED_WITH_SESSION_REPLAY
    },
  }
}
