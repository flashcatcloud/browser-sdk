import {
  addEventListener,
  clearTimeout,
  createEndpointUrlBuilder,
  noop,
  setTimeout,
  timeStampNow,
  ONE_SECOND,
} from '@flashcatcloud/browser-core'
import type { Observable, TimeoutId } from '@flashcatcloud/browser-core'
import type { RumConfiguration, RumInitConfiguration } from './configuration'

/**
 * Sampling rates the application owner can change from the console, without the customer shipping a
 * new release of their site.
 *
 * By default a change only affects sessions created after it arrives, so a visitor is never dropped
 * halfway through and never starts being recorded halfway through. The console can also ask for the
 * change to land immediately, which ends the running session so a new one starts under the new
 * rates — see `ACTIVATION_IMMEDIATE`.
 *
 * Nothing here runs unless `remoteConfiguration: true`. Left off — the default — the SDK makes no
 * extra request and behaves exactly as it did before this existed.
 */

const CONFIG_PATH = '/api/v2/rum/config'
const STORE_KEY_PREFIX = '_fc_rc_'
const DEFAULT_FETCH_TIMEOUT = 3 * ONE_SECOND
const DEFAULT_TTL = 600 * ONE_SECOND

/**
 * End the running session as soon as rates that change this client arrive, so a new session starts
 * under them. Chosen in the console, per application.
 *
 * Ending and restarting is deliberate: it is not the same as flipping the running session's decision
 * in place. A session that was not being collected has no id and no history, so "flipping" it would
 * invent a session that appears to begin mid-visit; and a collected session flipped off would simply
 * stop, looking like it ended early. Restarting keeps every session a complete record of itself, and
 * reuses the expiry path the SDK already has — the recorder flushes and starts again from a fresh
 * full snapshot, exactly as it does when a session times out.
 */
const ACTIVATION_IMMEDIATE = 'immediate'

export interface RemoteSampling {
  sessionSampleRate?: number
  sessionReplaySampleRate?: number
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
 * Everything needed to fetch and store the rates, resolved once at init. Undefined on the
 * configuration means the site did not opt in, and is what switches every read, write and request
 * off in one place.
 */
export interface RemoteSamplingSetup {
  url: string
  storeKey: string
  fetchTimeout: number
}

interface RemoteConfigurationResponse {
  version: number
  ttl: number
  enabled: boolean
  activation: string
  /**
   * Whether this application may ask again when the page comes back into view. Off unless an
   * operator turned it on: unlike the poll, which spreads requests out, coming back concentrates
   * them at the moment everyone opens their tabs again.
   */
  refresh_on_foreground: boolean
  rum: RemoteSampling
  custom?: Record<string, unknown>
}

/**
 * Read the rates that apply right now. Reading straight from storage rather than from a value held
 * in memory is what lets a rate fetched by one page load apply to the very first session of the
 * next one, instead of every visit starting on the local settings until a request comes back.
 */
export function readRemoteSampling(setup: RemoteSamplingSetup | undefined): RemoteSampling {
  if (!setup) {
    return {}
  }

  try {
    const stored = localStorage.getItem(setup.storeKey)
    return stored ? (JSON.parse(stored) as RemoteSampling) : {}
  } catch {
    // Storage unavailable or holding something we did not write: fall back to the local settings.
    return {}
  }
}

/**
 * Start keeping the stored rates fresh for the life of the page.
 *
 * The first fetch is issued immediately but nothing waits for it — initialisation is never delayed
 * and collection never pauses, whatever the endpoint does. Later fetches follow the ttl the server
 * asks for, which is what keeps a long-lived single-page application from running on the rates it
 * happened to load with.
 *
 * `endCurrentSession` is called only when the server asked for immediate activation AND the rates
 * this client will now draw with actually differ from the ones its running session was drawn with.
 * Both halves matter: without the first, a routine poll would cut sessions in half; without the
 * second, every poll would.
 */
export function startRemoteConfiguration(
  configuration: RumConfiguration,
  endCurrentSession: () => void,
  pageActivationObservable: Observable<void>
) {
  const setup = configuration.remoteSampling
  return setup ? keepSamplingFresh(configuration, setup, endCurrentSession, pageActivationObservable) : noop
}

function keepSamplingFresh(
  configuration: RumConfiguration,
  setup: RemoteSamplingSetup,
  endCurrentSession: () => void,
  pageActivationObservable: Observable<void>
) {
  let timeoutId: TimeoutId | undefined
  let lastFetchTime = 0
  let currentTtl = DEFAULT_TTL
  let refreshOnForeground = false

  function scheduleNext(delay: number) {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(fetchOnce, delay)
  }

  function fetchOnce() {
    // Armed before the request goes out, so a request that never comes back still leads to another
    // attempt rather than leaving the page on whatever it last knew, forever.
    lastFetchTime = timeStampNow()
    scheduleNext(DEFAULT_TTL)

    fetchRemoteConfiguration(configuration, setup, readRemoteSampling(setup).version, (response) => {
      const before = effectiveRates(configuration, readRemoteSampling(setup))
      store(setup, response)
      const after = effectiveRates(configuration, readRemoteSampling(setup))

      if (response.activation === ACTIVATION_IMMEDIATE && !sameRates(before, after)) {
        endCurrentSession()
      }

      // Follow the server's ttl rather than a constant of ours, so how fast a change propagates
      // stays a server-side decision.
      currentTtl = response.ttl > 0 ? response.ttl * ONE_SECOND : DEFAULT_TTL
      refreshOnForeground = !!response.refresh_on_foreground
      scheduleNext(currentTtl)
    })
  }

  // A page the visitor left and came back to has usually missed its refresh: browsers throttle
  // timers hard in hidden tabs, and a page restored from the back-forward cache may not have run
  // one for hours, so someone can come back and carry on under settings that changed while they
  // were away.
  //
  // Asking on the way back fixes that, and is off unless the server says otherwise. The poll
  // spreads requests out across the ttl; coming back does the opposite, bunching them at the
  // moments people return to their tabs, which is the shape the endpoint copes with worst. It is
  // worth that for an application whose owner needs a change to land within minutes, and not worth
  // it for everyone else, so it is theirs to turn on rather than ours to assume.
  const activationSubscription = pageActivationObservable.subscribe(() => {
    if (shouldRefreshOnActivation(refreshOnForeground, timeStampNow() - lastFetchTime, currentTtl)) {
      fetchOnce()
    }
  })

  fetchOnce()

  return () => {
    activationSubscription.unsubscribe()
    clearTimeout(timeoutId)
  }
}

/**
 * Whether coming back to the page is a reason to ask again.
 *
 * Both halves matter and they guard different things: the permission keeps the request pattern —
 * a burst as people return to their tabs — off unless someone chose it, and the age keeps
 * switching tabs back and forth from becoming a request each time.
 */
export function shouldRefreshOnActivation(allowed: boolean, ageOfSettings: number, ttl: number) {
  return allowed && ageOfSettings >= ttl
}

/**
 * The rates this client would draw with: whatever the console sent, falling back per knob to what
 * the site passed to init. Comparing these rather than the raw stored values is what makes "did
 * anything change for me?" exact — a console that sends the same number the site already used has
 * changed nothing, and must not cost anyone a session.
 */
function effectiveRates(configuration: RumConfiguration, remote: RemoteSampling) {
  return {
    session: remote.sessionSampleRate ?? configuration.sessionSampleRate,
    replay: remote.sessionReplaySampleRate ?? configuration.sessionReplaySampleRate,
  }
}

function sameRates(a: { session: number; replay: number }, b: { session: number; replay: number }) {
  return a.session === b.session && a.replay === b.replay
}

/**
 * Any failure — network error, timeout, non-200, unparseable body — leaves the stored rates exactly
 * as they were. Clearing them on failure would swing a whole fleet back to its local settings the
 * moment the endpoint had a bad minute, which is the opposite of what a customer wants from a knob
 * they turned deliberately.
 */
function fetchRemoteConfiguration(
  configuration: RumConfiguration,
  setup: RemoteSamplingSetup,
  appliedVersion: number | undefined,
  callback: (response: RemoteConfigurationResponse) => void
) {
  const xhr = new XMLHttpRequest()

  addEventListener(configuration, xhr, 'load', () => {
    if (xhr.status !== 200) {
      return
    }
    try {
      callback(JSON.parse(xhr.responseText) as RemoteConfigurationResponse)
    } catch {
      // Not something we can act on, and not something worth telling the customer about.
    }
  })

  // Telling the server which version this client is running is what lets the console answer "has
  // my change reached everyone yet". It is sent on the request every client makes, kept or not.
  xhr.open('GET', appliedVersion ? `${setup.url}&applied_version=${appliedVersion}` : setup.url)
  xhr.timeout = setup.fetchTimeout
  xhr.send()
}

function store(setup: RemoteSamplingSetup, response: RemoteConfigurationResponse) {
  const rates: RemoteSampling = { version: response.version }
  if (response.enabled && response.rum) {
    // Each rate is copied only when the server actually sent it. A rate nobody configured must stay
    // with whatever the site passed to init: writing a 0 in its place would silently switch off
    // collection the customer never asked to switch off.
    if (isRate(response.rum.sessionSampleRate)) {
      rates.sessionSampleRate = response.rum.sessionSampleRate
    }
    if (isRate(response.rum.sessionReplaySampleRate)) {
      rates.sessionReplaySampleRate = response.rum.sessionReplaySampleRate
    }
  }
  // The custom bag rides along untouched — the platform's job is delivery, its meaning belongs to
  // the host application. Gone from the response (or the kill switch off) means gone from storage.
  if (response.enabled && response.custom && typeof response.custom === 'object') {
    rates.custom = response.custom
  }

  try {
    // Written even with no rates in it — that is what "remote configuration is off, use your own
    // settings" looks like — so that the version is kept either way and the console can still see
    // that this client is up to date with the change that turned it off.
    localStorage.setItem(setup.storeKey, JSON.stringify(rates))
  } catch {
    // Storage unavailable: the rates simply do not survive this page load.
  }
}

export function buildRemoteSamplingSetup(initConfiguration: RumInitConfiguration): RemoteSamplingSetup | undefined {
  if (!initConfiguration.remoteConfiguration) {
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
 * on every SDK upgrade and put the first session after an upgrade back on the local settings.
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
  const parameters = [`client_token=${encodeURIComponent(initConfiguration.clientToken)}`, 'sdk=web']
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
