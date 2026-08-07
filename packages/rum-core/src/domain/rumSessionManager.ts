import type { RelativeTime, TrackingConsentState } from '@flashcatcloud/browser-core'
import {
  BridgeCapability,
  Observable,
  STORAGE_POLL_DELAY,
  bridgeSupports,
  clearInterval,
  getEventBridge,
  noop,
  performDraw,
  setInterval,
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
}

export type RumSession = {
  id: string
  sessionReplay: SessionReplayState
  anonymousId?: string
}

export const enum RumTrackingType {
  NOT_TRACKED = '0',
  TRACKED_WITH_SESSION_REPLAY = '1',
  TRACKED_WITHOUT_SESSION_REPLAY = '2',
}

export const enum SessionReplayState {
  OFF,
  SAMPLED,
  FORCED,
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
  })
  return {
    findTrackedSession: (startTime) => {
      const session = sessionManager.findSession(startTime)
      if (!session || !isTypeTracked(session.trackingType)) {
        return
      }
      return {
        id: session.id,
        sessionReplay:
          session.trackingType === RumTrackingType.TRACKED_WITH_SESSION_REPLAY
            ? SessionReplayState.SAMPLED
            : session.isReplayForced
              ? SessionReplayState.FORCED
              : SessionReplayState.OFF,
        anonymousId: session.anonymousId,
      }
    },
    expire: sessionManager.expire,
    expireObservable: sessionManager.expireObservable,
    setForcedReplay: () => sessionManager.updateSessionState({ forcedReplay: '1' }),
  }
}

/**
 * Session id used whenever the host application cannot name the session this page is in — either
 * because it was built against an SDK that predates `getSessionId()`, or because it has no session
 * at this moment. The host overrides the session id of every event it forwards, so this never
 * reaches the intake through the bridge.
 *
 * It would reach the intake for Session Replay segments, which this page uploads directly, and it
 * is a constant shared by every application built on this SDK. Nothing may therefore be recorded
 * while this is the session id — see `startRumSessionManagerStub`, which pairs it with
 * `SessionReplayState.OFF`.
 */
export const STUB_SESSION_ID = '00000000-aaaa-0000-aaaa-000000000000'

/**
 * What `getSessionId()` answers when the host application owns the session id and has none right
 * now. Distinct from `undefined`, which is a host that does not answer for it at all.
 */
const NO_HOST_SESSION = ''

export interface RumSessionManagerStub extends RumSessionManager {
  stop: () => void
}

/**
 * Start a tracked replay session stub
 */
export function startRumSessionManagerStub(
  configuration: RumConfiguration,
  lifeCycle: LifeCycle
): RumSessionManagerStub {
  // FLASHCAT FORK - the host application owns the session id and the anonymous id, and answers for
  // them through `DatadogEventBridge`. Both getters are absent on hosts built against an older SDK,
  // hence the fallbacks below.
  const bridge = getEventBridge()

  // FLASHCAT FORK (3/4) - see `sessionReplayDirectUpload` in RumInitConfiguration.
  // Upstream only ever samples the stub for replay when the host declares the `records` capability,
  // meaning the host records for us. With the option, this page records itself, so the draw is ours
  // to make.
  const sessionReplay =
    bridgeSupports(BridgeCapability.RECORDS) ||
    (configuration.sessionReplayDirectUpload && performDraw(configuration.sessionReplaySampleRate))
      ? SessionReplayState.SAMPLED
      : SessionReplayState.OFF

  const expireObservable = new Observable<void>()
  expireObservable.subscribe(() => lifeCycle.notify(LifeCycleEventType.SESSION_EXPIRED))

  // FLASHCAT FORK - the host session ends and is renewed while this page keeps running, and the
  // bridge is pull-only: reading it again is the only way to notice. That is how the regular
  // session manager learns the same thing — it polls its own store every `STORAGE_POLL_DELAY` and
  // turns the transitions it sees into expire/renew notifications — so the stub mirrors it here
  // rather than inventing a second lifecycle. Everything already subscribed to those two events
  // then does the right thing: the recorder flushes its pending segment and stops, and starts
  // again on a fresh view (and so a fresh full snapshot) once the host has a session again.
  let lastSeenSessionId = readHostSessionId()
  const watchIntervalId =
    lastSeenSessionId === undefined
      ? undefined
      : setInterval(() => {
          const sessionId = readHostSessionId()!
          if (sessionId === lastSeenSessionId) {
            return
          }
          const hadSession = lastSeenSessionId !== NO_HOST_SESSION
          lastSeenSessionId = sessionId
          // A host may go straight from one session to the next without ever reporting a gap, so
          // both notifications can fire in the same tick. Order matters: subscribers read the
          // session back, and by now the bridge already answers with the new one.
          if (hadSession) {
            expireObservable.notify()
          }
          if (sessionId !== NO_HOST_SESSION) {
            lifeCycle.notify(LifeCycleEventType.SESSION_RENEWED)
          }
        }, STORAGE_POLL_DELAY)

  function readHostSessionId() {
    return bridge?.getSessionId()
  }

  return {
    // Read from the bridge on each call rather than from `lastSeenSessionId`: the poll above only
    // exists to spot transitions, and an event assembled between two polls must still carry the id
    // the host holds right now.
    findTrackedSession: (): RumSession => {
      const hostSessionId = readHostSessionId()
      const hasHostSession = hostSessionId !== NO_HOST_SESSION

      // While the host has no session, the two kinds of data this page produces carry very
      // different risk, so they are treated differently rather than both being dropped.
      //
      // Events go to the host, which overrides their session id before forwarding them — the
      // placeholder never reaches the intake through the bridge, so they keep flowing. They have
      // to: a host may well depend on them to know the user is still there. `fc-sdk-electron`
      // renews its session from the click actions this page reports, so a page that stops
      // reporting during the gap leaves the host with nothing to renew from, and the session that
      // was only paused never comes back.
      //
      // Session Replay segments are uploaded by this page directly, so nothing overrides them.
      // There is no session to attribute them to, and the placeholder is a constant every
      // application built on this SDK shares — so recording stops instead, and `SESSION_EXPIRED`
      // (notified by the poll above) makes the recorder flush what it holds rather than keep a
      // segment open across the gap.
      return {
        id: hasHostSession && hostSessionId ? hostSessionId : STUB_SESSION_ID,
        sessionReplay: hasHostSession ? sessionReplay : SessionReplayState.OFF,
        anonymousId: bridge?.getAnonymousId(),
      }
    },
    expire: noop,
    expireObservable,
    setForcedReplay: noop,
    stop: () => clearInterval(watchIntervalId),
  }
}

function computeSessionState(configuration: RumConfiguration, rawTrackingType?: string) {
  let trackingType: RumTrackingType
  if (hasValidRumSession(rawTrackingType)) {
    trackingType = rawTrackingType
  } else if (!performDraw(configuration.sessionSampleRate)) {
    trackingType = RumTrackingType.NOT_TRACKED
  } else if (!performDraw(configuration.sessionReplaySampleRate)) {
    trackingType = RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY
  } else {
    trackingType = RumTrackingType.TRACKED_WITH_SESSION_REPLAY
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
    trackingType === RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY
  )
}

function isTypeTracked(rumSessionType: RumTrackingType | undefined) {
  return (
    rumSessionType === RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY ||
    rumSessionType === RumTrackingType.TRACKED_WITH_SESSION_REPLAY
  )
}
