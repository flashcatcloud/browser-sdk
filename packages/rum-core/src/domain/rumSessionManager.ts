import type { DefaultPrivacyLevel, RelativeTime, TrackingConsentState } from '@flashcatcloud/browser-core'
import {
  BridgeCapability,
  Observable,
  SESSION_TIME_OUT_DELAY,
  STORAGE_POLL_DELAY,
  bridgeSupports,
  clearInterval,
  clocksOrigin,
  createValueHistory,
  display,
  getEventBridge,
  noop,
  performDraw,
  relativeNow,
  setInterval,
  startSessionManager,
} from '@flashcatcloud/browser-core'
import type { RemoteConfigValues, RumConfiguration } from './configuration'
import { isPrivacyLevel, isRate, readRemoteConfig } from './configuration'
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

/**
 * FLASHCAT FORK - the sampling decision this session was created under: the rates actually used at
 * the draw (after the remote values and `beforeSampling` had their say) and the remote settings
 * version they came from. Events carry these instead of the init values, so server-side
 * extrapolation and audits line up with the draw that kept the session — a session is never
 * re-judged, so the metadata must be from its creation, not from whatever arrived since.
 */
export interface DrawnConfiguration {
  version?: number
  sessionSampleRate: number
  sessionReplaySampleRate: number
  // Not drawn like the rates, but latched the same way and for the same reason: both are read
  // repeatedly for as long as the session lives — the trace rate on every request, the privacy
  // level on every recorded node — so both have to answer with what this session started under
  // rather than with whatever the console has since delivered.
  traceSampleRate: number
  defaultPrivacyLevel: DefaultPrivacyLevel
}

export type RumSession = {
  id: string
  sessionReplay: SessionReplayState
  anonymousId?: string
  // FLASHCAT FORK - absent when the draw used exactly what init passed — nothing to override then,
  // the events already report those values — and when the record of the draw did not survive
  // (storage unavailable).
  drawnConfiguration?: DrawnConfiguration
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
  // The draw history garbage-collects itself on a shared timer, so it owns something to stop —
  // like the stub's watch of the host session, and like every other history in this package.
): RumSessionManager & { stop: () => void } {
  // FLASHCAT FORK - set through `setForcedSession()`, read at draw time. Once set it stays set for
  // the page lifetime, so every session drawn after the call is collected with replay; the host
  // application decides on each page load whether to call again.
  let forcedSession = false

  // FLASHCAT FORK - the metadata of the most recent draw, captured inside `computeSessionState`
  // (which cannot know the session id — the id is generated afterwards) and married to the session
  // it created as soon as that session exists.
  let pendingDraw: DrawnConfiguration | undefined

  // FLASHCAT FORK - the decision each session was created under, indexed by the time it started
  // applying, exactly like the session contexts it belongs to one layer down. An event is assembled
  // after the fact — a resource can be turned into an event after the session that requested it has
  // already been renewed — so the decision has to be looked up at the event's own time rather than
  // read off whichever session happens to be current, or the event would report the rates of a draw
  // it had no part in.
  const drawnHistory = createValueHistory<DrawnConfiguration>({ expireDelay: SESSION_TIME_OUT_DELAY })

  const sessionManager = startSessionManager(
    configuration,
    RUM_SESSION_KEY,
    (rawTrackingType) =>
      computeSessionState(configuration, rawTrackingType, forcedSession, (drawn) => {
        pendingDraw = drawn
      }),
    trackingConsentState
  )

  sessionManager.expireObservable.subscribe(() => {
    lifeCycle.notify(LifeCycleEventType.SESSION_EXPIRED)
    drawnHistory.closeActive(relativeNow())
  })

  // FLASHCAT FORK - notes the decision the session that just became current was created under.
  // That draw happened either on this page — `pendingDraw`, which is also written out for everyone
  // else — or somewhere this page cannot see: another tab drawing the session it now shares, or a
  // previous page load whose session it just restored. Storage is what carries the decision across
  // both of those gaps, and reading it back is what keeps two tabs on one session from tracing and
  // reporting it under two different sets of rates.
  //
  // The record is written just after the session store already holds the new session, in the same
  // synchronous stack: a tab whose storage poll fell exactly between the two would find no record
  // and keep its own settings for that session. Writing it earlier is not possible from here — the
  // id it belongs to is generated inside the store, as that session is persisted.
  function trackDraw(startTime: RelativeTime) {
    const drawn = pendingDraw
    pendingDraw = undefined
    const sessionEntity = sessionManager.findSession()
    if (!sessionEntity?.id) {
      return
    }
    if (drawn) {
      writeDrawRecord(configuration, { id: sessionEntity.id, ...drawn })
      drawnHistory.add(drawn, startTime)
      return
    }
    const stored = readDrawRecord(configuration, sessionEntity.id)
    if (stored) {
      drawnHistory.add(stored, startTime)
    }
  }

  // FLASHCAT FORK - the very first draw happens inside startSessionManager, before any
  // subscription could see its renewal; every later draw announces itself through renew.
  trackDraw(clocksOrigin().relative)

  sessionManager.renewObservable.subscribe(() => {
    // Record the draw before anything reacts to the renewal, so the first events assembled for
    // the new session already carry it.
    trackDraw(relativeNow())
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
        // FLASHCAT FORK - looked up at the same time as the session itself, so an event that
        // belongs to a session already renewed still reports the draw that created it.
        drawnConfiguration: drawnHistory.find(startTime),
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
    stop: drawnHistory.stop,
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

function computeSessionState(
  configuration: RumConfiguration,
  rawTrackingType?: string,
  forcedSession?: boolean,
  // FLASHCAT FORK - called when a draw actually happens (never for a restored session) and lands
  // on something other than the init values, with the rates the draw used and the remote version
  // they came from.
  onDraw?: (drawn: DrawnConfiguration) => void
) {
  let trackingType: RumTrackingType
  if (hasValidRumSession(rawTrackingType)) {
    trackingType = rawTrackingType
  } else if (forcedSession) {
    // FLASHCAT FORK - a forced draw skips both lotteries. It sits in the draw branch on purpose:
    // an existing session keeps the decision it was created with, forcing only shapes new ones.
    trackingType = RumTrackingType.TRACKED_WITH_SESSION_REPLAY
    // Forcing is about whether this visitor is collected at all. It says nothing about which of
    // their requests carry trace headers or how their page is masked, so those two keep the
    // delivered values rather than being pinned like the rates.
    reportDraw(configuration, readRemoteConfig(configuration.remoteConfig), 100, 100, onDraw)
  } else {
    // FLASHCAT FORK - rates set in the console take precedence over the ones passed to init. They
    // are read here, inside the only branch that draws, so a session restored from the store keeps
    // the decision it was created with: settings arriving mid-session never start or stop
    // collecting for a visitor already on the site.
    const remote = readRemoteConfig(configuration.remoteConfig)

    let sessionSampleRate = remote.sessionSampleRate ?? configuration.sessionSampleRate
    let sessionReplaySampleRate = remote.sessionReplaySampleRate ?? configuration.sessionReplaySampleRate

    // FLASHCAT FORK - the application gets the last word, right at the draw. This is what turns the
    // delivered custom values into sampling decisions without a wasted first draw or a session
    // restart: the console ships the data (an allow-list, a cohort rule), the application's own
    // code interprets it here. Its failure modes must never reach session creation, so a thrown
    // error or a value outside 0..100 leaves the incoming rate in place.
    if (configuration.beforeSampling) {
      try {
        const override = configuration.beforeSampling({
          sessionSampleRate,
          sessionReplaySampleRate,
          custom: remote.custom,
        })
        if (override) {
          if (isRate(override.sessionSampleRate)) {
            sessionSampleRate = override.sessionSampleRate
          }
          if (isRate(override.sessionReplaySampleRate)) {
            sessionReplaySampleRate = override.sessionReplaySampleRate
          }
        }
      } catch (e) {
        display.error('beforeSampling threw an error:', e)
      }
    }

    reportDraw(configuration, remote, sessionSampleRate, sessionReplaySampleRate, onDraw)

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

/**
 * FLASHCAT FORK - hands the draw that just happened to whoever records it. Both draw branches
 * report the same shape and differ only in the rates: forcing pins them, an ordinary draw uses
 * what the console and the application settled on.
 *
 * What decides whether a draw is worth recording is the draw itself, not which feature produced it:
 * a draw that used exactly what init passed is already described by the events, so recording it
 * would buy nothing and cost a storage write on every site that turned none of this on. Everything
 * else is recorded — including a `beforeSampling` override or a forced session on a site with
 * remote configuration switched off, where the rates used and the rates init passed are precisely
 * the values that differ.
 */
function reportDraw(
  configuration: RumConfiguration,
  remote: RemoteConfigValues,
  sessionSampleRate: number,
  sessionReplaySampleRate: number,
  onDraw?: (drawn: DrawnConfiguration) => void
) {
  if (!onDraw) {
    return
  }
  const drawn: DrawnConfiguration = {
    version: remote.version,
    sessionSampleRate,
    sessionReplaySampleRate,
    traceSampleRate: remote.traceSampleRate ?? configuration.traceSampleRate,
    defaultPrivacyLevel: remote.defaultPrivacyLevel ?? configuration.defaultPrivacyLevel,
  }
  if (
    drawn.version === undefined &&
    drawn.sessionSampleRate === configuration.sessionSampleRate &&
    drawn.sessionReplaySampleRate === configuration.sessionReplaySampleRate &&
    drawn.traceSampleRate === configuration.traceSampleRate &&
    drawn.defaultPrivacyLevel === configuration.defaultPrivacyLevel
  ) {
    return
  }
  onDraw(drawn)
}

/**
 * FLASHCAT FORK - the record of the draw that created the current session, and the only channel
 * through which a page that did not perform that draw can learn of it: the tab that drew writes it
 * before any other tab can see the session, and a page load restoring a session finds it waiting.
 * One record is enough — it describes whichever session is current, and the id is checked on read,
 * so a record left behind by an expired session is inert rather than wrong.
 *
 * The read is not conditional on anything: a session is shared across tabs and page loads, so this
 * page cannot know whether the page or tab that drew it had a reason to record one. A site that
 * enabled none of this simply never wrote a record and the lookup finds nothing.
 */
function readDrawRecord(configuration: RumConfiguration, sessionId: string): DrawnConfiguration | undefined {
  let record: ({ id: string } & DrawnConfiguration) | undefined
  try {
    const stored = localStorage.getItem(configuration.drawStoreKey)
    record = stored ? (JSON.parse(stored) as { id: string } & DrawnConfiguration) : undefined
  } catch {
    // Storage unavailable, or holding something we did not write.
    return undefined
  }
  if (!record || typeof record !== 'object' || record.id !== sessionId) {
    return undefined
  }
  // The rates a session was drawn under are read back on every event assembled for it, so a record
  // that does not hold numbers is worse than no record at all: it would carry a value of the wrong
  // type into arithmetic rather than fall back to the settings the site passed to init. Anything in
  // a browser profile can be edited by hand or left behind by another version, so this is checked
  // on the way out as well as on the way in.
  if (!isRate(record.sessionSampleRate) || !isRate(record.sessionReplaySampleRate)) {
    return undefined
  }
  return {
    version: typeof record.version === 'number' ? record.version : undefined,
    sessionSampleRate: record.sessionSampleRate,
    sessionReplaySampleRate: record.sessionReplaySampleRate,
    // A record written before these two existed has neither, and so does one holding something we
    // cannot use. Falling back to init is the same answer the session was already getting, so an
    // SDK upgrade mid-session changes nothing about how it is traced or masked.
    traceSampleRate: isRate(record.traceSampleRate) ? record.traceSampleRate : configuration.traceSampleRate,
    defaultPrivacyLevel: isPrivacyLevel(record.defaultPrivacyLevel)
      ? record.defaultPrivacyLevel
      : configuration.defaultPrivacyLevel,
  }
}

function writeDrawRecord(configuration: RumConfiguration, record: { id: string } & DrawnConfiguration) {
  try {
    localStorage.setItem(configuration.drawStoreKey, JSON.stringify(record))
  } catch {
    // Storage unavailable: the record simply does not survive this page load.
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
