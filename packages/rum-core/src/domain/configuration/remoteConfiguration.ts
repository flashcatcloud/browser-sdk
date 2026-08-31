import {
  addEventListener,
  clearTimeout,
  createEndpointUrlBuilder,
  display,
  noop,
  setTimeout,
  ONE_SECOND,
} from '@flashcatcloud/browser-core'
import type { DefaultPrivacyLevel, TimeoutId } from '@flashcatcloud/browser-core'
import type { LifeCycle } from '../lifeCycle'
import { LifeCycleEventType } from '../lifeCycle'
import type { RumConfiguration, RumInitConfiguration } from './configuration'

declare const __BUILD_ENV__SDK_VERSION__: string

/**
 * SDK settings the application owner can change from the console, without the customer shipping a
 * new release of their site: the sampling rates, the trace sample rate, and how Session Replay
 * masks a page by default.
 *
 * A change only affects sessions created after it arrives, so a visitor is never dropped halfway
 * through and never starts being recorded halfway through. Fetching follows the same rhythm: once
 * at start-up and once whenever a new session begins — a change can only matter at the next draw,
 * so asking more often than sessions are drawn would be requests for nothing. There is no timer
 * between sessions; the server's `ttl` field is accepted and ignored, reserved for a future
 * polling mode.
 *
 * Nothing here runs unless `remoteConfigurationEnabled: true`. Left off — the default — the SDK makes no
 * extra request and behaves exactly as it did before this existed.
 */

const CONFIG_PATH = '/api/v2/rum/config'
/**
 * The `1` is the storage format version, not the SDK version: it changes only when the shape of
 * what we store changes, so an SDK upgrade keeps the cache (losing it would put the first session
 * after every upgrade back on the init values), while a format change orphans the old entry
 * instead of asking new code to parse it.
 */
const STORE_KEY_PREFIX = '_fc_rc_1_'
/**
 * The draw record's own format version, for the same reason and read the same way — see
 * `buildDrawStoreKey`.
 */
const DRAW_STORE_KEY_PREFIX = '_fc_draw_1_'
const DEFAULT_FETCH_TIMEOUT = 3 * ONE_SECOND

/**
 * A failed fetch is retried quickly, then patiently, then not at all until the next natural
 * trigger (a new session, or the next page load). The budget is deliberately tiny — two extra
 * requests per outage per open page, so a fleet can never turn an endpoint incident into a storm.
 *
 * Per page, not per visitor: this state lives in the page, and a session renewal reaches every tab
 * a visitor has open, so a visitor with three tabs spends three budgets. That is the same
 * multiplier their ordinary intake traffic already carries, and it is bounded by the tabs a person
 * can have open — unlike a timer, which would multiply by how long they leave them there.
 */
const RETRY_DELAYS = [5 * ONE_SECOND, 60 * ONE_SECOND]

export interface RemoteConfigValues {
  sessionSampleRate?: number
  sessionReplaySampleRate?: number
  /**
   * Which requests carry trace headers. Drawn from the session id like the other rates, so a
   * session traces all of its requests or none of them.
   */
  traceSampleRate?: number
  /**
   * How Session Replay masks a page by default. Latched at the draw with the rates, never applied
   * to a recording already running: the recorders read this value live, so changing it mid-way
   * would leave one replay partly masked and partly not, and an upload cannot be masked after the
   * fact.
   */
  defaultPrivacyLevel?: DefaultPrivacyLevel
  /**
   * Which version of the settings these rates came from. Reported back on the next request so the
   * console can say how far a change has actually reached — a question the events cannot answer,
   * because a session that was not kept sends none, and the miss rate is set by the very rate being
   * changed.
   *
   * It only ever goes up, rollbacks included: going back to earlier settings publishes them again
   * under a new, higher number. That is what lets a client tell settings it has not seen yet from
   * an older answer arriving late, which is the only reason it can refuse the second — see `store`.
   */
  version?: number
  /**
   * The application-defined bag the console delivers and the SDK hands to the host application
   * verbatim, without interpreting — see `getRemoteConfig()`.
   */
  custom?: Record<string, unknown>
}

/**
 * What the application's `beforeSampling` callback receives at the moment a new session is about to
 * be drawn: the rates that would apply (console-delivered, falling back to init) and the custom
 * values the console delivered. On the very first visit, before the first response has been
 * cached, `custom` is undefined and the rates are the init ones.
 */
export interface BeforeSamplingContext {
  sessionSampleRate: number
  sessionReplaySampleRate: number
  custom?: Record<string, unknown>
}

/**
 * The application's last word on the sampling of the session about to be drawn — see the
 * `beforeSampling` init option. Returning nothing, or an out-of-range rate, leaves the incoming
 * value in place.
 */
export type BeforeSamplingCallback = (
  context: BeforeSamplingContext
) => { sessionSampleRate?: number; sessionReplaySampleRate?: number } | void

/**
 * Everything needed to fetch and store the settings, resolved once at init. Undefined on the
 * configuration means the site did not opt in, and is what switches every read, write and request
 * off in one place.
 */
export interface RemoteConfigSetup {
  /**
   * The request URL for a client running `appliedVersion`. The version is built into the request
   * parameters rather than appended to a finished URL because behind a `proxy` the finished URL is
   * the proxy's own: everything the intake gets to see travels inside its `ddforward` parameter, so
   * anything appended after the fact is read by the proxy and dropped there.
   */
  buildUrl: (appliedVersion: number | undefined) => string
  storeKey: string
  fetchTimeout: number
}

/**
 * The shape this SDK knows how to read. The server stamps it on every response, and a value this
 * build does not recognise means the payload changed in a way it could misread — so the whole
 * response is discarded and the settings already in force are kept.
 *
 * Absent is treated as compatible: only a server older than the field itself omits it, and such a
 * server predates every shape change this guards against.
 */
const SUPPORTED_SCHEMA_VERSION = 1

interface RemoteConfigurationResponse {
  schema_version?: number
  version: number
  enabled: boolean
  /**
   * Absent is legal and means the same as empty: a response that turns the whole feature off has no
   * rates to carry. `store` already reads it that way, and the type now says so.
   */
  rum?: RemoteConfigValues
  custom?: Record<string, unknown>
}

/**
 * A 200 is not by itself proof that the body came from the configuration endpoint: a captive
 * portal, a misrouted proxy or a gateway error page can all answer 200 with something else
 * entirely. Anything that is not recognisably a configuration response is refused here rather than
 * stored, because storing it would overwrite the cache with an empty record and drop the whole
 * fleet back to its init settings for as long as that lasted.
 */
function isSupportedResponse(body: unknown): body is RemoteConfigurationResponse {
  if (!body || typeof body !== 'object') {
    return false
  }
  const candidate = body as Partial<RemoteConfigurationResponse>
  if (candidate.schema_version !== undefined && candidate.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    return false
  }
  // Every field the contract makes mandatory is checked, not just one of them. A body carrying a
  // numeric `version` and nothing else is precisely what an unrelated JSON endpoint answers, and
  // taking it for a configuration costs more than a wasted request: `store` would empty the cache,
  // and because the guard there only ever moves forward, the number it left behind would refuse
  // every genuine answer after it — including the console change made to undo the damage.
  //
  // Only the envelope is judged here. The application's own `custom` bag is not part of what makes
  // a body a configuration, so a malformed one is dropped by `store` and the rates beside it still
  // apply — refusing the whole response over it would let an application-level mistake switch the
  // platform-level knobs back off.
  return isVersion(candidate.version) && typeof candidate.enabled === 'boolean' && isOptionalBag(candidate.rum)
}

/**
 * Read the settings that apply right now. Reading straight from storage rather than from a value
 * held in memory is what lets a value fetched by one page load apply to the very first session of
 * the next one, instead of every visit starting on the local settings until a request comes back.
 */
export function readRemoteConfig(setup: RemoteConfigSetup | undefined): RemoteConfigValues {
  if (!setup) {
    return {}
  }

  try {
    const stored = localStorage.getItem(setup.storeKey)
    return stored ? readStoredValues(JSON.parse(stored)) : {}
  } catch {
    // Storage unavailable or holding something we did not write: fall back to the local settings.
    return {}
  }
}

/**
 * Storage is checked on the way out as strictly as a response is on the way in. Everything written
 * here passed those checks, but anything in a browser profile can be edited by hand, survives an
 * SDK downgrade, and is shared with whatever else writes to this origin. A value that is not a rate
 * must read as "not delivered" and leave the site's own setting in place: handed on instead, a
 * string where a number belongs reaches the arithmetic that assembles every event.
 */
function readStoredValues(parsed: unknown): RemoteConfigValues {
  if (!parsed || typeof parsed !== 'object') {
    return {}
  }
  const stored = parsed as Partial<RemoteConfigValues>
  const values: RemoteConfigValues = {}
  if (isVersion(stored.version)) {
    values.version = stored.version
  }
  if (isRate(stored.sessionSampleRate)) {
    values.sessionSampleRate = stored.sessionSampleRate
  }
  if (isRate(stored.sessionReplaySampleRate)) {
    values.sessionReplaySampleRate = stored.sessionReplaySampleRate
  }
  if (isRate(stored.traceSampleRate)) {
    values.traceSampleRate = stored.traceSampleRate
  }
  if (isPrivacyLevel(stored.defaultPrivacyLevel)) {
    values.defaultPrivacyLevel = stored.defaultPrivacyLevel
  }
  if (isBag(stored.custom)) {
    values.custom = stored.custom
  }
  return values
}

/**
 * Keep the stored settings as fresh as the sessions that read them.
 *
 * A fetch is issued at start-up and on every session renewal, and nothing ever waits for it —
 * initialisation is never delayed and collection never pauses, whatever the endpoint does. The
 * response lands in storage for the NEXT draw: the draw that triggered the fetch has already
 * happened by the time the response arrives, which is exactly the next-session semantics the
 * console promises.
 */
export function startRemoteConfiguration(configuration: RumConfiguration, lifeCycle: LifeCycle) {
  const setup = configuration.remoteConfig
  return setup ? keepConfigFresh(configuration, setup, lifeCycle) : noop
}

function keepConfigFresh(configuration: RumConfiguration, setup: RemoteConfigSetup, lifeCycle: LifeCycle) {
  let retryTimeoutId: TimeoutId | undefined
  let failedAttempts = 0
  let inFlight = false
  let stopped = false

  function fetchNow() {
    if (inFlight) {
      return
    }
    inFlight = true

    fetchRemoteConfiguration(configuration, setup, readRemoteConfig(setup).version, (response) => {
      inFlight = false
      if (stopped) {
        // The SDK was stopped while this request was in flight. Clearing the timer on the way out
        // cannot reach a retry that has not been scheduled yet, so the answer is dropped here:
        // storing it would write settings nobody is reading any more, and retrying would keep a
        // request cycle alive past the thing that started it.
        return
      }
      if (response) {
        failedAttempts = 0
        store(setup, response)
        return
      }
      if (failedAttempts < RETRY_DELAYS.length) {
        retryTimeoutId = setTimeout(fetchNow, jittered(RETRY_DELAYS[failedAttempts]))
        failedAttempts += 1
      }
      // Out of retries: give up until the next trigger. The stored settings stay as they were.
    })
  }

  function onTrigger() {
    clearTimeout(retryTimeoutId)
    failedAttempts = 0
    fetchNow()
  }

  const renewSubscription = lifeCycle.subscribe(LifeCycleEventType.SESSION_RENEWED, onTrigger)

  onTrigger()

  return () => {
    stopped = true
    renewSubscription.unsubscribe()
    clearTimeout(retryTimeoutId)
  }
}

/**
 * Spread a delay by ±20%. An endpoint incident aligns every failed client's retry clock to the
 * same moment; without this, recovery would be greeted by the whole fleet at once, exactly when
 * the endpoint is weakest.
 */
function jittered(delay: number) {
  return delay * (0.8 + 0.4 * Math.random())
}

/**
 * Any failure — network error, timeout, non-200, unparseable body — leaves the stored settings
 * exactly as they were. Clearing them on failure would swing a whole fleet back to its local settings the
 * moment the endpoint had a bad minute, which is the opposite of what a customer wants from a knob
 * they turned deliberately.
 *
 * Conditional requests are the HTTP stack's job, not ours: the server pairs `Cache-Control:
 * private, no-cache` with an `ETag`, so the browser cache revalidates on its own and answers this
 * request from cache on a 304 — no `If-None-Match` handling in here.
 */
function fetchRemoteConfiguration(
  configuration: RumConfiguration,
  setup: RemoteConfigSetup,
  appliedVersion: number | undefined,
  callback: (response: RemoteConfigurationResponse | undefined) => void
) {
  const xhr = new XMLHttpRequest()

  addEventListener(configuration, xhr, 'load', () => {
    if (xhr.status !== 200) {
      callback(undefined)
      return
    }
    try {
      const body: unknown = JSON.parse(xhr.responseText)
      callback(isSupportedResponse(body) ? body : undefined)
    } catch {
      callback(undefined)
    }
  })
  addEventListener(configuration, xhr, 'error', () => callback(undefined))
  addEventListener(configuration, xhr, 'timeout', () => callback(undefined))

  xhr.open('GET', setup.buildUrl(appliedVersion))
  xhr.timeout = setup.fetchTimeout
  xhr.send()
}

function store(setup: RemoteConfigSetup, response: RemoteConfigurationResponse) {
  // Settings are published under a number that only ever goes up — rolling back republishes the
  // old settings under a new, higher one — so a response numbered below what is already stored can
  // only be an older answer arriving late: another tab's request that crossed this one, or a copy
  // an intermediary kept. Applying it would put this client back on settings the console has
  // already replaced, and the next request would report a version the console believes nobody is
  // running any more.
  //
  // What it is compared against is storage, not a version held in memory here, because the two
  // requests that can cross are two pages, and storage is the only thing they share.
  const storedVersion = readRemoteConfig(setup).version
  if (storedVersion !== undefined && response.version < storedVersion) {
    return
  }

  const values: RemoteConfigValues = { version: response.version }
  if (response.enabled && response.rum) {
    // Each value is copied only when the server actually sent it. A knob nobody configured must
    // stay with whatever the site passed to init: writing a 0 in its place would silently switch
    // off collection the customer never asked to switch off.
    if (isRate(response.rum.sessionSampleRate)) {
      values.sessionSampleRate = response.rum.sessionSampleRate
    }
    if (isRate(response.rum.sessionReplaySampleRate)) {
      values.sessionReplaySampleRate = response.rum.sessionReplaySampleRate
    }
    if (isRate(response.rum.traceSampleRate)) {
      values.traceSampleRate = response.rum.traceSampleRate
    }
    // An unknown level is dropped rather than stored: a typo must not reach the recorders, where it
    // would fall through to "record everything" — the one outcome nobody asks for by accident.
    if (isPrivacyLevel(response.rum.defaultPrivacyLevel)) {
      values.defaultPrivacyLevel = response.rum.defaultPrivacyLevel
    }
  }
  // The custom bag rides along untouched — the platform's job is delivery, its meaning belongs to
  // the host application. Gone from the response (or the kill switch off) means gone from storage.
  if (response.enabled && isBag(response.custom)) {
    values.custom = response.custom
  }

  try {
    // Written even with nothing in it — that is what "remote configuration is off, use your own
    // settings" looks like — so that the version is kept either way and the console can still see
    // that this client is up to date with the change that turned it off.
    localStorage.setItem(setup.storeKey, JSON.stringify(values))
  } catch {
    // Storage unavailable, or the origin is out of room. The previous entry stays as it is, which
    // is the same "keep what is already working" answer a failed request gets — the client goes on
    // applying the settings it last stored, and goes on reporting their version.
  }
}

export function buildRemoteConfigSetup(initConfiguration: RumInitConfiguration): RemoteConfigSetup | undefined {
  if (!initConfiguration.remoteConfigurationEnabled) {
    return undefined
  }

  const buildUrl = createEndpointUrlBuilder(initConfiguration, 'rum', CONFIG_PATH)

  return {
    buildUrl: (appliedVersion) => buildUrl(buildParameters(initConfiguration, appliedVersion)),
    storeKey: buildStoreKey(initConfiguration),
    fetchTimeout: validFetchTimeout(initConfiguration.remoteConfigurationFetchTimeout),
  }
}

/**
 * An unusable timeout is replaced by the default rather than refusing `init`: this is a knob on a
 * background request, and losing every event on the page because of it would cost far more than it
 * could ever save. It cannot simply be passed through either — `xhr.timeout` takes an unsigned
 * long, so a string lands as `0` and a negative number wraps to weeks, and both mean the request
 * never gives up. Nothing resets the in-flight guard until a request finishes, so one that never
 * does would silently end every later refresh on the page.
 */
function validFetchTimeout(timeout: number | undefined) {
  if (timeout === undefined) {
    return DEFAULT_FETCH_TIMEOUT
  }
  if (typeof timeout !== 'number' || !(timeout > 0) || timeout === Infinity) {
    display.error('remoteConfigurationFetchTimeout should be a positive number of milliseconds')
    return DEFAULT_FETCH_TIMEOUT
  }
  return timeout
}

/**
 * The key covers everything that can change the answer — which application, on which host, in which
 * environment, at which version — so a visitor moving between two of them does not read the other's
 * rates. It deliberately leaves out the SDK version: including it would throw the stored rates away
 * on every SDK upgrade and put the first session after an upgrade back on the local settings. The
 * storage format version lives in `STORE_KEY_PREFIX` instead, so only a real format change orphans
 * the cache.
 *
 * The application version is in it for a reason the SDK version does not have: settings can be
 * targeted at a release, so two releases of one site that are live at the same time are entitled to
 * different rates. One entry between them would have each overwrite the other's on every fetch, for
 * as long as both are being served — so the version has to stay, and cannot be dropped to make the
 * limitation below go away.
 *
 * KNOWN LIMITATION - that costs an entry per deploy. The first session after a release reads the
 * local settings, and the entry the release before it used is never read again and never removed,
 * so they accumulate in a quota the host application shares.
 *
 * Sweeping them on write is not the answer, and was tried: nothing here can tell an abandoned entry
 * from the entry of a tab still open on yesterday's release, and deleting the latter drops that tab
 * to its local settings for a whole session — after which the two tabs delete each other's entry at
 * every renewal, which is a worse failure than the leak. A correct fix needs a way to know that no
 * page is still reading an entry: an age written beside the values and swept well past the session
 * timeout would do it, and is the shape to reach for if the accumulation ever bites.
 */
function buildStoreKey(initConfiguration: RumInitConfiguration) {
  return buildKey(STORE_KEY_PREFIX, identityParts(initConfiguration).concat(initConfiguration.version ?? ''))
}

/**
 * The key of the draw record the session manager writes. It shares the identity of the settings
 * cache but deliberately not its application version: the record belongs to the session, and a
 * session outlives a deploy. Keying it by version would lose the decision the moment a visitor with
 * a live session navigates onto a newly deployed page, putting that session's events and its
 * tracer back on the init values — the mid-session flip the record exists to prevent.
 *
 * Built for every site, not only the ones that opted in: `beforeSampling` and `setForcedSession()`
 * move a draw off the init values with remote configuration switched off.
 */
export function buildDrawStoreKey(initConfiguration: RumInitConfiguration) {
  return buildKey(DRAW_STORE_KEY_PREFIX, identityParts(initConfiguration))
}

// Which application, on which host, in which environment: a visitor moving between two of them
// must never read the other's.
function identityParts(initConfiguration: RumInitConfiguration) {
  return [initConfiguration.site ?? '', initConfiguration.applicationId, initConfiguration.env ?? '']
}

/**
 * The separator has to be a character `encodeURIComponent` escapes, or two different identities can
 * spell the same key: `_` is left alone by it, so env `prod` with version `1_0` and env `prod_1`
 * with version `0` would both come out as `..._prod_1_0` and share one cache entry. `|` is escaped
 * to `%7C`, so it can only ever appear here as the separator.
 */
function buildKey(prefix: string, parts: string[]) {
  return prefix + parts.map(encodeURIComponent).join('|')
}

function buildParameters(initConfiguration: RumInitConfiguration, appliedVersion: number | undefined) {
  // sdk_version rides along from the first release so settings can later be targeted at the
  // clients running a particular build — a rule that cannot be written retroactively, because the
  // clients it would have to match are the ones already deployed.
  const parameters = [
    // How the SDK recognises its own traffic and leaves it out of what it collects: `isIntakeUrl`
    // looks for these two parameters and nothing else. Without them this request is just another
    // XHR to the page, so every session renewal would file a resource event for it, and the
    // in-flight request would count towards the page activity that decides when a view finished
    // loading. They survive a `proxy` given as a string, which encodes the whole query into
    // `ddforward` — the substring match still finds them there.
    //
    // A `proxy` given as a function builds its own URL and may drop them, in which case this
    // request is collected like any other. That is the same exposure the intake requests
    // themselves already have under such a proxy, so it is left as it is rather than given a
    // second, divergent mechanism here.
    'ddsource=browser',
    `ddtags=${encodeURIComponent(`sdk_version:${__BUILD_ENV__SDK_VERSION__}`)}`,
    `client_token=${encodeURIComponent(initConfiguration.clientToken)}`,
    'sdk=web',
    `sdk_version=${encodeURIComponent(__BUILD_ENV__SDK_VERSION__)}`,
  ]
  if (initConfiguration.env) {
    parameters.push(`env=${encodeURIComponent(initConfiguration.env)}`)
  }
  if (initConfiguration.version) {
    parameters.push(`app_version=${encodeURIComponent(initConfiguration.version)}`)
  }
  // Telling the server which version this client is running is what lets the console answer "has
  // my change reached everyone yet". It rides on the request every client makes, kept or not.
  // Compared against `undefined` rather than tested for truth: `0` is a version like any other,
  // and a client running it must not report as a client running none.
  if (appliedVersion !== undefined) {
    parameters.push(`applied_version=${appliedVersion}`)
  }
  return parameters.join('&')
}

export function isRate(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 100
}

/**
 * A version is a publish counter, so anything that is not a whole, non-negative number small enough
 * to survive a JSON round trip cannot be one. Checked on the way in and on the way out, because a
 * version is the one value that can refuse a later answer: an implausible one is not merely
 * ignored, it freezes the settings stored beside it for as long as that entry lives.
 *
 * `MAX_SAFE_INTEGER` is spelled out rather than named so this keeps working on the ES5 targets the
 * bundle is checked against.
 */
function isVersion(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 9007199254740991 && Math.floor(value) === value
}

/**
 * An object the server filled in, as opposed to an array or a primitive. `typeof [] === 'object'`,
 * so the plain type check on its own lets a list through to `getRemoteConfig()`, where the host
 * application is promised a keyed bag.
 */
function isBag(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalBag(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || isBag(value)
}

export function isPrivacyLevel(value: unknown): value is DefaultPrivacyLevel {
  return value === 'mask' || value === 'mask-user-input' || value === 'allow'
}
