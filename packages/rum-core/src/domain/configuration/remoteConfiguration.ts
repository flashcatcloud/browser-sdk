import {
  addEventListener,
  clearTimeout,
  createEndpointUrlBuilder,
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
const DEFAULT_FETCH_TIMEOUT = 3 * ONE_SECOND

/**
 * A failed fetch is retried quickly, then patiently, then not at all until the next natural
 * trigger (a new session, or the next page load). The budget is deliberately tiny — two extra
 * requests per outage per client, so a fleet can never turn an endpoint incident into a storm.
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
  url: string
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
  rum: RemoteConfigValues
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
  return typeof candidate.version === 'number'
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
    return stored ? (JSON.parse(stored) as RemoteConfigValues) : {}
  } catch {
    // Storage unavailable or holding something we did not write: fall back to the local settings.
    return {}
  }
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

  function fetchNow() {
    if (inFlight) {
      return
    }
    inFlight = true

    fetchRemoteConfiguration(configuration, setup, readRemoteConfig(setup).version, (response) => {
      inFlight = false
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

  // Telling the server which version this client is running is what lets the console answer "has
  // my change reached everyone yet". It is sent on the request every client makes, kept or not.
  xhr.open('GET', appliedVersion ? `${setup.url}&applied_version=${appliedVersion}` : setup.url)
  xhr.timeout = setup.fetchTimeout
  xhr.send()
}

function store(setup: RemoteConfigSetup, response: RemoteConfigurationResponse) {
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
  if (response.enabled && response.custom && typeof response.custom === 'object') {
    values.custom = response.custom
  }

  try {
    // Written even with nothing in it — that is what "remote configuration is off, use your own
    // settings" looks like — so that the version is kept either way and the console can still see
    // that this client is up to date with the change that turned it off.
    localStorage.setItem(setup.storeKey, JSON.stringify(values))
  } catch {
    // Storage unavailable: the values simply do not survive this page load.
  }
}

export function buildRemoteConfigSetup(initConfiguration: RumInitConfiguration): RemoteConfigSetup | undefined {
  if (!initConfiguration.remoteConfigurationEnabled) {
    return undefined
  }

  const buildUrl = createEndpointUrlBuilder(initConfiguration, 'rum', CONFIG_PATH)

  return {
    url: buildUrl(buildParameters(initConfiguration)),
    storeKey: buildStoreKey(initConfiguration),
    fetchTimeout: initConfiguration.remoteConfigurationFetchTimeout ?? DEFAULT_FETCH_TIMEOUT,
  }
}

/**
 * The key covers everything that can change the answer — which application, on which host, in which
 * environment, at which version — so a visitor moving between two of them does not read the other's
 * rates. It deliberately leaves out the SDK version: including it would throw the stored rates away
 * on every SDK upgrade and put the first session after an upgrade back on the local settings. The
 * storage format version lives in `STORE_KEY_PREFIX` instead, so only a real format change orphans
 * the cache.
 */
function buildStoreKey(initConfiguration: RumInitConfiguration) {
  const parts = [
    initConfiguration.site ?? '',
    initConfiguration.applicationId,
    initConfiguration.env ?? '',
    initConfiguration.version ?? '',
  ]
  return STORE_KEY_PREFIX + parts.map(encodeURIComponent).join('_')
}

function buildParameters(initConfiguration: RumInitConfiguration) {
  // sdk_version rides along from the first release so settings can later be targeted at the
  // clients running a particular build — a rule that cannot be written retroactively, because the
  // clients it would have to match are the ones already deployed.
  const parameters = [
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
  return parameters.join('&')
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 100
}

function isPrivacyLevel(value: unknown): value is DefaultPrivacyLevel {
  return value === 'mask' || value === 'mask-user-input' || value === 'allow'
}
