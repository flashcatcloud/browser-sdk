import type { RelativeTime, TrackingConsentState } from '@flashcatcloud/browser-core'
import {
  BridgeCapability,
  DefaultPrivacyLevel,
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
import { isPrivacyLevel, isRate, isVersion, readRemoteConfig } from './configuration'
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
 * FLASHCAT FORK - a session manager this page started, and therefore has to stop: each owns
 * something that outlives a single call — the draw history's shared garbage collection here, the
 * watch of the host application's session in the stub.
 */
export interface StartedRumSessionManager extends RumSessionManager {
  stop: () => void
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
  //
  // Latched for the page that drew them, and for any page that may read them back — which is only
  // a page that opted into remote configuration. A page that did not always answers with its own
  // init values, because nothing available to it could have moved these two in the first place, so
  // a stored value disagreeing is not one this SDK wrote. See `readDrawRecord`.
  //
  // Undefined means no rule set a trace rate at all — neither the console nor `init`. That is a
  // different statement from "100", and the events have to keep it: `rule_psr` describes the rule
  // the tracer drew under, and the backend extrapolates from it, so a site that never asked for
  // trace sampling must go on sending no rule rather than a rule of 100%. The tracer itself reads
  // this as "use the built configuration's rate", which is what it did before any of this existed.
  traceSampleRate: number | undefined
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
): StartedRumSessionManager {
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
    (rawTrackingType) => {
      // FLASHCAT FORK - the store can compute a state and then throw the whole attempt away: a lock
      // corrupted by another tab makes it start over from the state that tab left behind. What a
      // discarded attempt drew must not outlive it, because the attempt that replaces it may find a
      // session that tab already drew, keep it, and draw nothing — and the renewal that follows
      // would then marry this page's dead draw to a session it had no part in creating, and write
      // it where every other tab reads it. Every attempt starts from nothing drawn.
      pendingDraw = undefined
      return computeSessionState(configuration, rawTrackingType, forcedSession, (drawn) => {
        pendingDraw = drawn
      })
    },
    trackingConsentState
  )

  sessionManager.expireObservable.subscribe(() => {
    lifeCycle.notify(LifeCycleEventType.SESSION_EXPIRED)
    drawnHistory.closeActive(relativeNow())
  })

  // FLASHCAT FORK - the record holds the id of the session it describes, and withdrawing consent is
  // the one moment the SDK promises that id stops existing: the session store is rewritten without
  // it. Storage does not expire on its own, so without this the copy kept here would outlive the
  // withdrawal for good, and be there for a consent audit to find.
  //
  // Only on withdrawal, and deliberately not when a session merely expires. A session ends by
  // expiring and renewing all the time, and the tab that notices an expiry is not always the tab
  // that drew what replaced it: deleting there would let a page still polling remove the record
  // another page had just written for the new session, leaving every tab back on its own settings.
  // A withdrawal has no such successor — nothing is meant to be adopted after it.
  const consentSubscription = trackingConsentState.observable.subscribe(() => {
    if (!trackingConsentState.isGranted()) {
      forgetDrawRecord(configuration)
    }
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
  // id it belongs to is generated inside the store, as that session is persisted. The record is
  // read only here, when a session is adopted, so such a tab keeps its own settings for the whole
  // remaining life of that session rather than until its next poll.
  //
  // Storage is also per origin while the session need not be: with `trackSessionAcrossSubdomains`
  // a session arrives on the next subdomain with no record waiting, and is reported and traced
  // there under the values that subdomain passed to init. See `remoteConfigurationEnabled`.
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

  // FLASHCAT FORK - a change published mid-session normally waits for that session to end on its
  // own, which for a visitor who never goes idle is hours away. Three changes cannot afford the
  // wait, and what makes exactly those three special is that their outcome for the running session
  // can be asserted without drawing again:
  //
  //   - a session sample rate of 0 while this session is being collected: nothing is meant to be
  //     collected any more, and this is the emergency stop the console offers;
  //   - a session sample rate of 100 while this session is not: everything is meant to be
  //     collected, and this visitor is the exception;
  //   - a stricter default privacy level: every further second recorded is a second of plaintext
  //     uploaded, and masking cannot reach back for it.
  //
  // No other rate says anything about whether THIS session should have been kept — only a second
  // draw could, and drawing twice silently turns a rate p into p². So everything else waits for
  // the next session, a loosening privacy level included. Loosening waits on purpose: the delay
  // is what leaves an operator room to undo a mistake, and what it costs meanwhile is more of the
  // data already being collected.
  //
  // The action is always to end the session and let the next activity start a new one — never to
  // flip the running one, which would leave a replay masked in its first half and plain in its
  // second, or invent a session that begins in the middle of a visit.
  //
  // It stays idempotent with no bookkeeping at all: it compares what this session was drawn under
  // against what a draw would use now, and ending the session is exactly what makes that
  // difference disappear. The same response arriving again — another tab, a retry, a reload —
  // finds nothing left to act on.
  function endSessionIfSettingsAreDecisive() {
    if (!configuration.remoteConfig) {
      return
    }
    const session = sessionManager.findSession()
    if (!session) {
      // Nothing to end. Whatever starts the next session draws on the settings just stored, which
      // is the ordinary path and already gives them their effect.
      return
    }

    const remote = readRemoteConfig(configuration.remoteConfig)

    // What this session is masking pages with right now, which is not the previously stored
    // settings: settings are stored while a session runs, and the session was drawn under whatever
    // was stored before that. No record means the draw used the init value, and so does the
    // session.
    const drawnPrivacyLevel = drawnHistory.find()?.defaultPrivacyLevel ?? configuration.defaultPrivacyLevel
    const nextPrivacyLevel = remote.defaultPrivacyLevel ?? configuration.defaultPrivacyLevel
    if (PRIVACY_LEVEL_STRICTNESS[nextPrivacyLevel] > PRIVACY_LEVEL_STRICTNESS[drawnPrivacyLevel]) {
      sessionManager.expire()
      return
    }

    if (forcedSession) {
      // The host application has taken this page off the rates deliberately, and every draw it
      // makes from now on is collected whatever the console says. Ending the session on a rate
      // would only replace it with another forced one — the same difference, forever.
      return
    }

    // Whether this session is collected is read off the session itself rather than reconstructed
    // by comparing rates: the session IS the outcome its draw produced, and an outcome is the only
    // thing 0 and 100 let us assert anything about.
    const isCollected = isTypeTracked(session.trackingType)
    const { sessionSampleRate } = resolveSampleRates(configuration, remote)
    if ((sessionSampleRate === 0 && isCollected) || (sessionSampleRate === 100 && !isCollected)) {
      sessionManager.expire()
    }
  }

  const remoteConfigSubscription = lifeCycle.subscribe(
    LifeCycleEventType.REMOTE_CONFIGURATION_STORED,
    endSessionIfSettingsAreDecisive
  )

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
    stop: () => {
      consentSubscription.unsubscribe()
      remoteConfigSubscription.unsubscribe()
      drawnHistory.stop()
    },
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

/**
 * Start a tracked replay session stub
 */
export function startRumSessionManagerStub(
  configuration: RumConfiguration,
  lifeCycle: LifeCycle
): StartedRumSessionManager {
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
    const { sessionSampleRate, sessionReplaySampleRate } = resolveSampleRates(configuration, remote)

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
 * FLASHCAT FORK - the rates a draw would use right now: what the console delivered, falling back to
 * what the site passed to init, with the application's `beforeSampling` given the last word. This
 * is what turns the delivered custom values into sampling decisions without a wasted first draw or
 * a session restart: the console ships the data (an allow-list, a cohort rule), the application's
 * own code interprets it here. Its failure modes must never reach session creation, so a thrown
 * error or a value outside 0..100 leaves the incoming rate in place.
 *
 * It resolves rates and never draws on them, which is what lets the same question be asked away
 * from a draw — see `endSessionIfSettingsAreDecisive`, which needs to know which rate would apply
 * without spending a lottery ticket to find out.
 */
function resolveSampleRates(configuration: RumConfiguration, remote: RemoteConfigValues) {
  let sessionSampleRate = remote.sessionSampleRate ?? configuration.sessionSampleRate
  let sessionReplaySampleRate = remote.sessionReplaySampleRate ?? configuration.sessionReplaySampleRate

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

  return { sessionSampleRate, sessionReplaySampleRate }
}

/**
 * FLASHCAT FORK - how much of a page each level keeps out of a recording, ordered so two levels can
 * be compared. Only the direction matters: tightening is the change that cannot be undone after the
 * fact, because a second already recorded in the clear has already been uploaded in the clear.
 */
const PRIVACY_LEVEL_STRICTNESS: { [level in DefaultPrivacyLevel]: number } = {
  [DefaultPrivacyLevel.ALLOW]: 0,
  [DefaultPrivacyLevel.MASK_USER_INPUT]: 1,
  [DefaultPrivacyLevel.MASK]: 2,
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
    traceSampleRate: remote.traceSampleRate ?? initTraceRule(configuration),
    defaultPrivacyLevel: remote.defaultPrivacyLevel ?? configuration.defaultPrivacyLevel,
  }
  if (
    drawn.version === undefined &&
    drawn.sessionSampleRate === configuration.sessionSampleRate &&
    drawn.sessionReplaySampleRate === configuration.sessionReplaySampleRate &&
    drawn.traceSampleRate === initTraceRule(configuration) &&
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
  // These two can only ever have been moved by remote configuration: `beforeSampling` and
  // `setForcedSession()` shape the rates and reach neither of them. So on a site that did not opt
  // in, a stored value differing from init is not one this SDK wrote — it is stale, hand-edited, or
  // left by something else on the origin — and honouring it would let a single storage write take a
  // site that asked for `mask`, and enabled nothing, into recording a replay unmasked.
  //
  // Opted in, the console is allowed to relax masking; that is the feature, and the site asked for
  // it. Opted out, there is no authority for the value at all.
  const mayHaveBeenDelivered = configuration.remoteConfig !== undefined
  return {
    // Same reasoning as the two below: a settings version can only have come from settings. On a
    // site that opted out it would put a version onto every event that no delivered configuration
    // ever stood behind — and that number is exactly what an auditor uses to look the settings up.
    version: mayHaveBeenDelivered && isVersion(record.version) ? record.version : undefined,
    sessionSampleRate: record.sessionSampleRate,
    sessionReplaySampleRate: record.sessionReplaySampleRate,
    // A record written before these two existed has neither, and so does one holding something we
    // cannot use. Falling back to init is the same answer the session was already getting, so an
    // SDK upgrade mid-session changes nothing about how it is traced or masked.
    traceSampleRate:
      mayHaveBeenDelivered && isRate(record.traceSampleRate) ? record.traceSampleRate : initTraceRule(configuration),
    defaultPrivacyLevel:
      mayHaveBeenDelivered && isPrivacyLevel(record.defaultPrivacyLevel)
        ? record.defaultPrivacyLevel
        : configuration.defaultPrivacyLevel,
  }
}

function forgetDrawRecord(configuration: RumConfiguration) {
  try {
    localStorage.removeItem(configuration.drawStoreKey)
  } catch {
    // Storage unavailable, which also means there was nothing written to forget.
  }
}

function writeDrawRecord(configuration: RumConfiguration, record: { id: string } & DrawnConfiguration) {
  try {
    localStorage.setItem(configuration.drawStoreKey, JSON.stringify(record))
  } catch {
    // Storage unavailable: the record simply does not survive this page load.
  }
}

/**
 * FLASHCAT FORK - the trace rate a rule set at `init`, or undefined when the site set none.
 * `configuration.traceSampleRate` cannot answer that question: it defaults to 100 whether or not
 * anybody asked for it. `rulePsr` is the built configuration's own record of "was one configured at
 * all", so it is what decides here, and the two stay in step by construction.
 */
function initTraceRule(configuration: RumConfiguration) {
  return configuration.rulePsr !== undefined ? configuration.traceSampleRate : undefined
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
