import type { RelativeTime, TrackingConsentState } from '@flashcatcloud/browser-core'
import {
  BridgeCapability,
  Observable,
  STORAGE_POLL_DELAY,
  bridgeSupports,
  clearInterval,
  display,
  getEventBridge,
  noop,
  performDraw,
  setInterval,
  startSessionManager,
} from '@flashcatcloud/browser-core'
import type { RumConfiguration } from './configuration'
import { readRemoteSampling } from './configuration'
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
  setForcedSession: () => void
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
  // FLASHCAT FORK - set through `setForcedSession()`, read at draw time. Once set it stays set for
  // the page lifetime, so every session drawn after the call is collected with replay; the host
  // application decides on each page load whether to call again.
  let forcedSession = false

  const sessionManager = startSessionManager(
    configuration,
    RUM_SESSION_KEY,
    (rawTrackingType) => computeSessionState(configuration, rawTrackingType, forcedSession),
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
    // FLASHCAT FORK - the escape hatch for "collect this visitor NOW": the host application knows
    // who needs debugging (its own allow-list, a support flow), the SDK only provides the switch.
    // A session keeps the decision it was drawn with, so forcing a visitor that was not being
    // collected means ending their current (empty) session; the next activity draws again with
    // `forcedSession` set and starts a collected session with replay. A session already collected
    // only needs replay forced on, which is the existing forced-replay path.
    setForcedSession: () => {
      forcedSession = true
      const session = sessionManager.findSession()
      if (!session || !isTypeTracked(session.trackingType)) {
        sessionManager.expire()
      } else if (session.trackingType === RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY) {
        sessionManager.updateSessionState({ forcedReplay: '1' })
      }
    },
  }
}

/**
 * Session id used when the host application does not answer for one, because it was built against
 * an SDK that predates `getSessionId()`. Such a host is expected to override the session id of the
 * events it forwards, so the placeholder never reaches the intake for RUM events.
 *
 * It would reach the intake for Session Replay segments, which this page uploads directly, and the
 * placeholder is a constant shared by every application — so a host that DOES answer for the
 * session id must never end up on it. See `startRumSessionManagerStub`.
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
    findTrackedSession: (): RumSession | undefined => {
      const sessionId = readHostSessionId()
      if (sessionId === NO_HOST_SESSION) {
        // The host owns the session and currently has none. There is nothing to attribute this
        // page's data to, so it has no tracked session either — falling back to the placeholder
        // would pile Session Replay segments onto a fake session shared across applications, and
        // reusing the id the host had a moment ago would pile them onto a session that ended.
        return
      }
      return {
        id: sessionId ?? STUB_SESSION_ID,
        sessionReplay,
        anonymousId: bridge?.getAnonymousId(),
      }
    },
    expire: noop,
    expireObservable,
    setForcedReplay: noop,
    setForcedSession: noop,
    stop: () => clearInterval(watchIntervalId),
  }
}

function computeSessionState(configuration: RumConfiguration, rawTrackingType?: string, forcedSession?: boolean) {
  let trackingType: RumTrackingType
  if (hasValidRumSession(rawTrackingType)) {
    trackingType = rawTrackingType
  } else if (forcedSession) {
    // FLASHCAT FORK - a forced draw skips both lotteries. It sits in the draw branch on purpose:
    // an existing session keeps the decision it was created with, forcing only shapes new ones.
    trackingType = RumTrackingType.TRACKED_WITH_SESSION_REPLAY
  } else {
    // FLASHCAT FORK - rates set in the console take precedence over the ones passed to init. They
    // are read here, inside the only branch that draws, so a session restored from the store keeps
    // the decision it was created with: settings arriving mid-session never start or stop
    // collecting for a visitor already on the site.
    const remote = readRemoteSampling(configuration.remoteSampling)

    let sessionSampleRate = remote.sessionSampleRate ?? configuration.sessionSampleRate
    let sessionReplaySampleRate = remote.sessionReplaySampleRate ?? configuration.sessionReplaySampleRate

    // FLASHCAT FORK - the application gets the last word, right at the draw. This is what turns the
    // delivered custom values into sampling decisions without a wasted first draw or a session
    // restart: the console ships the data (an allow-list, a cohort rule), the application's own
    // code interprets it here. Its failure modes must never reach session creation, so a thrown
    // error or a value outside 0..100 leaves the incoming rate in place.
    if (configuration.beforeSampling) {
      try {
        const override = configuration.beforeSampling({ sessionSampleRate, sessionReplaySampleRate, custom: remote.custom })
        if (override) {
          if (isSampleRate(override.sessionSampleRate)) {
            sessionSampleRate = override.sessionSampleRate
          }
          if (isSampleRate(override.sessionReplaySampleRate)) {
            sessionReplaySampleRate = override.sessionReplaySampleRate
          }
        }
      } catch (e) {
        display.error('beforeSampling threw an error:', e)
      }
    }

    if (!performDraw(sessionSampleRate)) {
      trackingType = RumTrackingType.NOT_TRACKED
    } else if (!performDraw(sessionReplaySampleRate)) {
      trackingType = RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY
    } else {
      trackingType = RumTrackingType.TRACKED_WITH_SESSION_REPLAY
    }
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

function isSampleRate(value: number | undefined): value is number {
  return typeof value === 'number' && value >= 0 && value <= 100
}

function isTypeTracked(rumSessionType: RumTrackingType | undefined) {
  return (
    rumSessionType === RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY ||
    rumSessionType === RumTrackingType.TRACKED_WITH_SESSION_REPLAY
  )
}
