import type { ContextManager, CookieOptions, TimeoutId, TrackingConsentState } from '@flashcatcloud/browser-core'
import {
  DOM_EVENT,
  ONE_DAY,
  ONE_SECOND,
  SessionPersistence,
  addEventListener,
  canUseEventBridge,
  clearTimeout,
  createEndpointUrlBuilder,
  dateNow,
  deleteCookie,
  display,
  getCookie,
  getInitCookie,
  getSyntheticsResultId,
  getSyntheticsTestId,
  noop,
  selectSessionStoreStrategyType,
  setCookie,
  setTimeout,
} from '@flashcatcloud/browser-core'
import type { RumConfiguration, RumInitConfiguration } from './configuration'
import type { LifeCycle } from './lifeCycle'
import { LifeCycleEventType } from './lifeCycle'
import type { RumSessionManager } from './rumSessionManager'

// replaced at build time
declare const __BUILD_ENV__SDK_VERSION__: string

/**
 * FLASHCAT FORK - the dedicated "this device / this user is active today" report.
 *
 * Ordinary RUM events reach the intake in batches, and only for sessions the sampling draw kept,
 * so a visitor who opens the page for a few seconds — or whose session was not drawn — may never
 * appear in the day's unique-visitor count at all. This report exists to close that gap: one tiny
 * request per day and per (device, user) pair, sent as soon as the identity is known, outside the
 * batch and outside sampling. The backend writes it to its own daily-active table and answers the
 * "active devices" and "logged-in users" counts from there; view events keep flowing exactly as
 * before and are merged into the same table server-side, so a client that never sends this (an
 * older SDK) is still counted from its views.
 *
 * Wire contract (the intake's, shared with the native SDKs and `@flashcatcloud/electron-sdk`):
 * `POST /api/v2/rum/active?dd-api-key=...` — plus `ddsource`/`ddtags` here, so this SDK leaves
 * its own traffic out of what it collects — with one JSON object, identity nested the way RUM
 * events carry it:
 *
 * - `usr.anonymous_id`: the anonymous id, absent when anonymous tracking is off
 * - `usr.id`: the id set through `setUser`, absent when nobody is logged in. Deliberately the raw
 * context value, never the copy of the anonymous id the user context puts in `usr.id` for
 * logged-out visitors — that copy would count every device as a logged-in user here.
 * - `service`, `env`, `version`, `build_version`, `sdk_version`, and the platform facts under
 * `os` and `device` (for a web page, read coarsely off the user agent: the endpoint does not
 * parse one itself)
 * - `age_ms`: how long ago the reported activity first tried to leave this client. The hour a
 * report belongs to is the server's call (receipt time minus this), never the device clock's.
 *
 * The application is named by the client token, not the body. An application type the intake
 * refuses gets a 4xx, which this code treats as final — the report is dropped, never retried
 * day after day.
 *
 * The server answers 202. Like the configuration endpoint it is mounted beside, this request is
 * not an event: it must not consume event quota. Behind a `proxy` it travels inside `ddforward`
 * like every other request this SDK makes, so a proxy that allow-lists forwarded paths has to be
 * told about `/api/v2/rum/active` — the same caveat `remoteConfigurationEnabled` carries.
 *
 * Nothing here runs under an event bridge. In an Electron renderer or a mobile WebView the host
 * application owns the device identity (it is what hands this page its anonymous id) and sends
 * the report itself; a second one from the page would either double-report the same device or,
 * worse, report the page's own short-lived identity next to the host's stable one.
 */

const ACTIVE_PATH = '/api/v2/rum/active'
const STORE_KEY_PREFIX = '_fc_active_2_'
const REQUEST_TIMEOUT = 10 * ONE_SECOND
/** In-process retries of one beacon, the budget the native SDKs' beacons run on. */
const RETRY_DELAYS = [2 * ONE_SECOND, 8 * ONE_SECOND]
/** A report that still has not left after this long is dropped rather than delivered stale. */
const MAX_PENDING_AGE = 3 * ONE_DAY
/** Bounds on what one origin can be made to store, whatever the application does with `setUser`. */
const MAX_SENT_COMBINATIONS = 50
const MAX_PENDING_REPORTS = 10

export interface ActivePingSetup {
  buildUrl: () => string
  storeKey: string
  storage: ActivePingStorage
  // The built configuration carries `env` only as a tag, so the value the report itself carries
  // is captured here, where the init configuration is still at hand.
  env: string | undefined
}

/**
 * Where the sent-marks and the undelivered reports live between pages. Which store backs this
 * follows `sessionPersistence`, like the session record: a site that keeps its sessions in a
 * cookie does not expect this SDK to write localStorage either. Nothing here is load-bearing —
 * losing the store costs at most a repeated request or a dropped remainder, never collection.
 */
export interface ActivePingStorage {
  read: () => StoredState | undefined
  write: (state: StoredState) => void
  remove: () => void
}

interface ActiveBeaconBody {
  service?: string
  env?: string
  version?: string
  build_version: string
  sdk_version: string
  usr: { anonymous_id?: string; id?: string }
  os: { name: string; version: string }
  device: { type: string; model: string; brand: string }
}

interface PendingReport {
  combination: string
  report: ActiveBeaconBody
  firstAttemptAt: number
}

interface StoredState {
  day: string
  sent: string[]
  pending: PendingReport[]
}

export function buildActivePingSetup(initConfiguration: RumInitConfiguration): ActivePingSetup {
  const buildUrl = createEndpointUrlBuilder(initConfiguration, 'rum', ACTIVE_PATH)
  const storeKey = buildStoreKey(initConfiguration)
  return {
    buildUrl: () => buildUrl(buildParameters(initConfiguration)),
    storeKey,
    storage: buildActiveStorage(initConfiguration, storeKey),
    env: initConfiguration.env ?? undefined,
  }
}

function buildParameters(initConfiguration: RumInitConfiguration) {
  // `ddsource` and `ddtags` are what make the SDK recognise this request as its own intake
  // traffic and leave it out of what it collects; the token names the application.
  return [
    'ddsource=browser',
    `ddtags=${encodeURIComponent(`sdk_version:${__BUILD_ENV__SDK_VERSION__}`)}`,
    `dd-api-key=${encodeURIComponent(initConfiguration.clientToken)}`,
  ].join('&')
}

function buildStoreKey(initConfiguration: RumInitConfiguration) {
  const parts = [initConfiguration.site ?? '', initConfiguration.applicationId, initConfiguration.env ?? '']
  // One key for every store, so it must be a legal cookie name too: the cookie reader only
  // recognises keys of word characters and hyphens (findCommaSeparatedValue), which rules out
  // the '|' separators and '%' escapes a plain encodeURIComponent join would produce.
  return STORE_KEY_PREFIX + parts.map((part) => encodeURIComponent(part).replace(/[^\w-]/g, '-')).join('_')
}

export function startActivePing(
  configuration: RumConfiguration,
  lifeCycle: LifeCycle,
  sessionManager: RumSessionManager,
  userContext: ContextManager,
  trackingConsentState: TrackingConsentState
) {
  const setup = configuration.activePing
  if (!setup || canUseEventBridge() || isAutomatedSession()) {
    return { stop: noop }
  }

  let stopped = false
  let inFlight = false
  let retryTimeoutId: TimeoutId | undefined
  let failedAttempts = 0
  // The combination this page last reported, and whether the queue was empty behind it.
  // User context updates can fire on every route change; answering those from here keeps
  // the storage read off that hot path. The store stays the source of truth — this only
  // ever short-circuits a repeat within the page, and never while work is queued.
  let lastReportedCombination: string | undefined
  let lastReportedDrained = false

  const attempt = () => {
    if (stopped || !trackingConsentState.isGranted()) {
      return
    }
    // A new combination is only "activity" when somebody can see the page. A prerendered or
    // backgrounded tab starting the SDK is not a visit; it reports when it becomes visible.
    // The identity is worked out before storage is touched so the repeat check above can run.
    let deviceKey = ''
    let userId = ''
    let combination: string | undefined
    if (document.visibilityState === 'visible') {
      deviceKey = configuration.trackAnonymousUser ? (sessionManager.getAnonymousId() ?? '') : ''
      userId = currentUserId(userContext)
      if (deviceKey || userId) {
        combination = combinationOf(deviceKey, userId, configuration.version ?? '')
        if (combination === lastReportedCombination && lastReportedDrained) {
          return
        }
      }
    }
    const state = readState(setup)
    prunePending(state)
    lastReportedDrained = state.pending.length === 0
    // Today's activity is recorded before the in-flight check below can return early. A
    // login that starts and ends while an earlier report is still unanswered is activity
    // today, and the moment it happened — not the moment the network answers — is what
    // dates it: queue the combination now and let the sends drain serially.
    recordCurrentCombination(state, deviceKey, userId, combination)
    if (inFlight) {
      return
    }
    // Yesterday's undelivered reports go first: they are the ones closest to ageing out, and
    // sending them costs the same request whether or not today also has something to say.
    const pending = state.pending[0]
    if (pending) {
      send(pending)
    }
  }

  /** Queues today's (device, user) combination, once, whether or not it can leave yet. */
  const recordCurrentCombination = (
    state: StoredState,
    deviceKey: string,
    userId: string,
    combination: string | undefined
  ) => {
    if (!combination) {
      return
    }
    // The application version is part of what was reported: a deploy the same day is
    // reported for the new version too, the intake keeping a row per version.
    if (state.sent.includes(combination)) {
      lastReportedCombination = combination
      return
    }
    if (state.pending.some((candidate) => candidate.combination === combination)) {
      return
    }
    const facts = userAgentFacts()
    const report: ActiveBeaconBody = {
      service: configuration.service,
      env: setup.env,
      version: configuration.version,
      build_version: '',
      sdk_version: __BUILD_ENV__SDK_VERSION__,
      usr: {
        ...(deviceKey ? { anonymous_id: deviceKey } : {}),
        ...(userId ? { id: userId } : {}),
      },
      os: facts.os,
      device: facts.device,
    }
    // Kept before it is sent, not after: a page closed a second later has already lost its
    // request, and the next page to start is what delivers this one.
    state.pending.push({ combination, report, firstAttemptAt: dateNow() })
    prunePending(state)
    lastReportedDrained = false
    writeState(setup, state)
  }

  const send = (pending: PendingReport) => {
    inFlight = true
    request(
      setup,
      configuration,
      { ...pending.report, age_ms: Math.max(0, dateNow() - pending.firstAttemptAt) },
      (outcome) => {
        inFlight = false
        // A response landing after consent was withdrawn must not write the state back:
        // withdrawing consent deleted it precisely so no identifier of this visitor is kept.
        if (stopped || !trackingConsentState.isGranted()) {
          return
        }
        const current = readState(setup)
        if (outcome === 'accepted') {
          failedAttempts = 0
          current.pending = current.pending.filter((candidate) => !sameReport(candidate, pending))
          // Only a report about today earns the "already sent" shortcut; a stale one delivered
          // late says nothing about today, whose combination still has to go out.
          if (isToday(pending.firstAttemptAt) && !current.sent.includes(pending.combination)) {
            current.sent.push(pending.combination)
            current.sent = current.sent.slice(-MAX_SENT_COMBINATIONS)
          }
          lastReportedCombination = pending.combination
          writeState(setup, current)
          // More may be queued behind this one: an older report, or today's, which the send above
          // was standing in for.
          attempt()
        } else if (outcome === 'rejected') {
          // The server answered about this report itself; asking again would get the same answer.
          // The combination is marked as reported all the same, so an application the intake
          // refuses on principle is not re-asked at every trigger for the rest of the day.
          failedAttempts = 0
          current.pending = current.pending.filter((candidate) => !sameReport(candidate, pending))
          if (isToday(pending.firstAttemptAt) && !current.sent.includes(pending.combination)) {
            current.sent.push(pending.combination)
            current.sent = current.sent.slice(-MAX_SENT_COMBINATIONS)
          }
          lastReportedCombination = pending.combination
          lastReportedDrained = current.pending.length === 0
          writeState(setup, current)
          // Whatever was queued behind it still goes out; only this one was refused.
          const next = current.pending[0]
          if (next) {
            send(next)
          }
        } else {
          scheduleRetry()
        }
      }
    )
  }

  const scheduleRetry = () => {
    if (failedAttempts >= RETRY_DELAYS.length) {
      failedAttempts = 0
      return
    }
    const delay = RETRY_DELAYS[failedAttempts] * (0.8 + 0.4 * Math.random())
    failedAttempts += 1
    retryTimeoutId = setTimeout(() => {
      retryTimeoutId = undefined
      attempt()
    }, delay)
  }

  const onConsentChange = () => {
    if (trackingConsentState.isGranted()) {
      attempt()
    } else {
      // Consent withdrawn takes the undelivered reports with it: they describe activity the
      // visitor has just said not to track, and keeping them would send exactly that on a later
      // visit. The whole entry goes, sent-marks included — they are identifiers too.
      clearTimeout(retryTimeoutId)
      retryTimeoutId = undefined
      lastReportedCombination = undefined
      lastReportedDrained = false
      setup.storage.remove()
    }
  }

  const subscriptions = [
    lifeCycle.subscribe(LifeCycleEventType.SESSION_RENEWED, attempt),
    userContext.changeObservable.subscribe(attempt),
    trackingConsentState.observable.subscribe(onConsentChange),
  ]
  const { stop: stopVisibility } = addEventListener(configuration, document, DOM_EVENT.VISIBILITY_CHANGE, () => {
    if (document.visibilityState === 'visible') {
      attempt()
    }
  })

  attempt()

  return {
    stop: () => {
      stopped = true
      clearTimeout(retryTimeoutId)
      subscriptions.forEach((subscription) => subscription.unsubscribe())
      stopVisibility()
    },
  }
}

type RequestOutcome = 'accepted' | 'rejected' | 'retry'

function request(
  setup: ActivePingSetup,
  configuration: RumConfiguration,
  payload: ActiveBeaconBody & { age_ms: number },
  done: (outcome: RequestOutcome) => void
) {
  let answered = false
  const answer = (outcome: RequestOutcome) => {
    if (!answered) {
      answered = true
      done(outcome)
    }
  }
  try {
    const xhr = new XMLHttpRequest()
    addEventListener(configuration, xhr, 'load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        answer('accepted')
      } else if (xhr.status === 429 || xhr.status >= 500) {
        answer('retry')
      } else {
        answer('rejected')
      }
    })
    addEventListener(configuration, xhr, 'error', () => answer('retry'))
    addEventListener(configuration, xhr, 'timeout', () => answer('retry'))
    // The one that always arrives, as in the remote-configuration request: an aborted request
    // fires none of the three above, and without this the in-flight guard would never clear.
    addEventListener(configuration, xhr, 'loadend', () => answer('retry'))
    xhr.open('POST', setup.buildUrl())
    // text/plain keeps the request CORS-safelisted: no preflight, so the beacon also works
    // against intakes that do not answer OPTIONS for this endpoint.
    xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8')
    xhr.timeout = REQUEST_TIMEOUT
    xhr.send(JSON.stringify(payload))
  } catch (error) {
    display.error('active report could not be sent:', error)
    answer('retry')
  }
}

/**
 * A synthetics run or a CI-driven browser is not a visitor: it mints a fresh anonymous id on
 * every run, and the endpoint stamps every beacon as a user session, so letting one through
 * would count a device that does not exist. Detected the same way the session contexts detect
 * them for events.
 */
function isAutomatedSession(): boolean {
  if (getSyntheticsTestId() && getSyntheticsResultId()) {
    return true
  }
  // Kept in sync with CI_VISIBILITY_TEST_ID_COOKIE_NAME in contexts/ciVisibilityContext,
  // spelled out rather than imported: the configuration module imports this one's setup
  // builder, so a runtime import back through the contexts would close a circle for a string.
  const ciTestExecutionId =
    getInitCookie('datadog-ci-visibility-test-execution-id') ||
    (window as { Cypress?: { env: (key: string) => string | undefined } }).Cypress?.env('traceId')
  return typeof ciTestExecutionId === 'string'
}

function currentUserId(userContext: ContextManager): string {
  const id = userContext.getContext().id
  return typeof id === 'string' ? id : ''
}

/**
 * The platform facts of this page, read coarsely off the user agent. Deliberately not a user
 * agent parser: the beacon's dimensions only have to agree broadly with what the intake derives
 * for the same visitor's views, and anything unrecognised stays empty rather than guessed.
 */
function userAgentFacts(): { os: ActiveBeaconBody['os']; device: ActiveBeaconBody['device'] } {
  const ua = navigator.userAgent
  let os = { name: '', version: '' }
  let type = 'Desktop'
  const ios = /(?:iPhone|iPad|iPod).*?OS (\d+)[_.](\d+)/.exec(ua)
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua)
  const mac = /Mac OS X (\d+)[_.](\d+)/.exec(ua)
  if (ios) {
    os = { name: 'iOS', version: `${ios[1]}.${ios[2]}` }
    type = ua.includes('iPad') ? 'tablet' : 'mobile'
  } else if (android) {
    os = { name: 'Android', version: android[1] }
    type = ua.includes('Mobile') ? 'mobile' : 'tablet'
  } else if (mac) {
    os = { name: 'Mac OS X', version: `${mac[1]}.${mac[2]}` }
  } else if (ua.includes('Windows')) {
    os = { name: 'Windows', version: '' }
  } else if (ua.includes('Linux')) {
    os = { name: 'Linux', version: '' }
  }
  return { os, device: { type, model: '', brand: '' } }
}

function combinationOf(deviceKey: string, userId: string, version: string) {
  return [deviceKey, userId, version].map(encodeURIComponent).join('|')
}

function sameReport(a: PendingReport, b: PendingReport) {
  return a.combination === b.combination && a.firstAttemptAt === b.firstAttemptAt
}

function localDay(time: number) {
  const date = new Date(time)
  const month = `0${date.getMonth() + 1}`.slice(-2)
  const day = `0${date.getDate()}`.slice(-2)
  return `${date.getFullYear()}-${month}-${day}`
}

function isToday(time: number) {
  return localDay(time) === localDay(dateNow())
}

function prunePending(state: StoredState) {
  const now = dateNow()
  state.pending = state.pending.filter((pending) => now - pending.firstAttemptAt <= MAX_PENDING_AGE)
  state.pending = state.pending.slice(-MAX_PENDING_REPORTS)
}

function readState(setup: ActivePingSetup): StoredState {
  const today = localDay(dateNow())
  const parsed = setup.storage.read()
  if (parsed) {
    // A new local day retires the sent-marks. Judged on the device clock on purpose: the
    // marks only save requests, and being wrong costs at most one extra request — the hour a
    // report is counted under is decided by the server from `age_ms`.
    return parsed.day === today ? parsed : { day: today, sent: [], pending: parsed.pending }
  }
  return { day: today, sent: [], pending: [] }
}

function parseState(parsed: unknown): StoredState | undefined {
  if (!parsed || typeof parsed !== 'object') {
    return undefined
  }
  const candidate = parsed as Partial<StoredState>
  if (typeof candidate.day !== 'string' || !Array.isArray(candidate.sent) || !Array.isArray(candidate.pending)) {
    return undefined
  }
  return {
    day: candidate.day,
    sent: candidate.sent.filter((entry): entry is string => typeof entry === 'string'),
    pending: candidate.pending.filter(isPendingReport),
  }
}

function isPendingReport(candidate: unknown): candidate is PendingReport {
  if (!candidate || typeof candidate !== 'object') {
    return false
  }
  const { combination, report, firstAttemptAt } = candidate as Partial<PendingReport>
  return (
    typeof combination === 'string' &&
    typeof firstAttemptAt === 'number' &&
    !!report &&
    typeof report === 'object' &&
    !!report.usr &&
    typeof report.usr === 'object' &&
    (typeof report.usr.anonymous_id === 'string' || typeof report.usr.id === 'string')
  )
}

function writeState(setup: ActivePingSetup, state: StoredState) {
  setup.storage.write(state)
}

/** A cookie holding the state must outlive the oldest report it may still carry. */
const COOKIE_STATE_EXPIRY = MAX_PENDING_AGE + ONE_DAY
/**
 * Bounds for the cookie store, tighter than the general ones: a cookie has a hard size limit
 * (about 4KB) and rides on every request to the site's own servers, so it keeps only the most
 * recent marks and remainders. The general bounds still apply within a page.
 */
const COOKIE_MAX_SENT_COMBINATIONS = 8
const COOKIE_MAX_PENDING_REPORTS = 3

function buildActiveStorage(initConfiguration: RumInitConfiguration, storeKey: string): ActivePingStorage {
  // The session store's own strategy choice, reused rather than mirrored: whatever store
  // the session record lives in is the store this state lives in, by construction.
  const strategy = selectSessionStoreStrategyType(initConfiguration)
  if (strategy?.type === SessionPersistence.COOKIE) {
    return cookieStorage(storeKey, strategy.cookieOptions)
  }
  if (strategy?.type === SessionPersistence.LOCAL_STORAGE) {
    return localStorageStorage(storeKey)
  }
  // No store the session settings allow (cookies refused, no localStorage fallback opted in):
  // the marks live for this page only, which costs repeated requests, never wrong counts.
  let memory: StoredState | undefined
  return {
    read: () => memory,
    write: (state) => {
      memory = state
    },
    remove: () => {
      memory = undefined
    },
  }
}

function localStorageStorage(storeKey: string): ActivePingStorage {
  return {
    read: () => {
      try {
        const stored = localStorage.getItem(storeKey)
        return stored ? parseState(JSON.parse(stored)) : undefined
      } catch {
        // Storage unavailable or holding something we did not write.
        return undefined
      }
    },
    write: (state) => {
      try {
        localStorage.setItem(storeKey, JSON.stringify(state))
      } catch {
        // Storage that refuses costs the undelivered reports, nothing more.
      }
    },
    remove: () => {
      try {
        localStorage.removeItem(storeKey)
      } catch {
        // Nothing else can be done about storage that refuses.
      }
    },
  }
}

function cookieStorage(storeKey: string, options: CookieOptions): ActivePingStorage {
  return {
    read: () => {
      try {
        const stored = getCookie(storeKey)
        return stored ? parseState(JSON.parse(decodeURIComponent(stored))) : undefined
      } catch {
        return undefined
      }
    },
    write: (state) => {
      try {
        const trimmed: StoredState = {
          day: state.day,
          sent: state.sent.slice(-COOKIE_MAX_SENT_COMBINATIONS),
          pending: state.pending.slice(-COOKIE_MAX_PENDING_REPORTS),
        }
        setCookie(storeKey, encodeURIComponent(JSON.stringify(trimmed)), COOKIE_STATE_EXPIRY, options)
      } catch {
        // A cookie that refuses costs the undelivered reports, nothing more.
      }
    },
    remove: () => {
      try {
        deleteCookie(storeKey, options)
      } catch {
        // Nothing else can be done about a cookie that refuses.
      }
    },
  }
}
