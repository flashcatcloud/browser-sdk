import {
  addEventListener,
  clearTimeout,
  createEndpointUrlBuilder,
  setTimeout,
  ONE_SECOND,
} from '@flashcatcloud/browser-core'
import type { TimeoutId } from '@flashcatcloud/browser-core'
import type { RumInitConfiguration } from './configuration'

/**
 * Sampling rates the application owner can change from the console, without the customer shipping a
 * new release of their site.
 *
 * The rates are only read when a session is created, so a change never disturbs a session already
 * running: a visitor is never dropped halfway through, and never starts being recorded halfway
 * through either. It applies from the next session onwards.
 *
 * Nothing here runs unless `remoteConfiguration: true`. Left off — the default — the SDK makes no
 * extra request and behaves exactly as it did before this existed.
 */

const CONFIG_PATH = '/api/v2/rum/config'
const STORE_KEY_PREFIX = '_fc_rc_'
const DEFAULT_FETCH_TIMEOUT = 3 * ONE_SECOND
const DEFAULT_TTL = 300 * ONE_SECOND

export interface RemoteSampling {
  sessionSampleRate?: number
  sessionReplaySampleRate?: number
}

interface RemoteConfigurationResponse {
  version: number
  ttl: number
  enabled: boolean
  rum: RemoteSampling
}

/**
 * Read the rates that apply right now. Reading straight from storage rather than from a value held
 * in memory is what lets a rate fetched by one page load apply to the very first session of the
 * next one, instead of every visit starting on the local settings until a request comes back.
 */
export function readRemoteSampling(storeKey: string | undefined): RemoteSampling {
  if (!storeKey) {
    return {}
  }

  try {
    const stored = localStorage.getItem(storeKey)
    return stored ? (JSON.parse(stored) as RemoteSampling) : {}
  } catch {
    // Storage unavailable or holding something we did not write: fall back to the local settings.
    return {}
  }
}

/**
 * Start keeping the stored rates fresh for the life of the page.
 * The first fetch is issued immediately but nothing waits for it — initialisation is never delayed
 * and collection never pauses, whatever the endpoint does. Later fetches follow the ttl the server
 * asks for, which is what keeps a long-lived single-page application from running on the rates it
 * happened to load with.
 */
export function startRemoteConfiguration(initConfiguration: RumInitConfiguration) {
  const storeKey = buildRemoteSamplingStoreKey(initConfiguration)
  if (storeKey) {
    keepSamplingFresh(initConfiguration, storeKey)
  }
}

function keepSamplingFresh(initConfiguration: RumInitConfiguration, storeKey: string) {
  const buildUrl = createEndpointUrlBuilder(initConfiguration, 'rum', CONFIG_PATH)
  const url = buildUrl(buildParameters(initConfiguration))

  let timeoutId: TimeoutId | undefined

  function scheduleNext(delay: number) {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(fetchOnce, delay)
  }

  function fetchOnce() {
    // Armed before the request goes out, so a request that never comes back still leads to another
    // attempt rather than leaving the page on whatever it last knew, forever.
    scheduleNext(DEFAULT_TTL)

    fetchRemoteConfiguration(initConfiguration, url, (response) => {
      store(storeKey, response)

      // Follow the server's ttl rather than a constant of ours, so how fast a change propagates
      // stays a server-side decision.
      scheduleNext(response.ttl > 0 ? response.ttl * ONE_SECOND : DEFAULT_TTL)
    })
  }

  fetchOnce()
}

/**
 * Any failure — network error, timeout, non-200, unparseable body — leaves the stored rates exactly
 * as they were. Clearing them on failure would swing a whole fleet back to its local settings the
 * moment the endpoint had a bad minute, which is the opposite of what a customer wants from a knob
 * they turned deliberately.
 */
function fetchRemoteConfiguration(
  initConfiguration: RumInitConfiguration,
  url: string,
  callback: (response: RemoteConfigurationResponse) => void
) {
  const xhr = new XMLHttpRequest()

  addEventListener(initConfiguration, xhr, 'load', () => {
    if (xhr.status !== 200) {
      return
    }
    try {
      callback(JSON.parse(xhr.responseText) as RemoteConfigurationResponse)
    } catch {
      // Not something we can act on, and not something worth telling the customer about.
    }
  })

  xhr.open('GET', url)
  xhr.timeout = initConfiguration.remoteConfigurationFetchTimeout ?? DEFAULT_FETCH_TIMEOUT
  xhr.send()
}

function store(storeKey: string, response: RemoteConfigurationResponse) {
  const rates: RemoteSampling = {}
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

  try {
    if (rates.sessionSampleRate === undefined && rates.sessionReplaySampleRate === undefined) {
      // Remote configuration was turned off, or never turned on. Forget what we knew so the next
      // session goes back to the site's own settings.
      localStorage.removeItem(storeKey)
    } else {
      localStorage.setItem(storeKey, JSON.stringify(rates))
    }
  } catch {
    // Storage unavailable: the rates simply do not survive this page load.
  }
}

/**
 * The key covers everything that can change the answer — which application, on which host, in which
 * environment, at which version — so a visitor moving between two of them does not read the other's
 * rates. It deliberately leaves out the SDK version: including it would throw the stored rates away
 * on every SDK upgrade and put the first session after an upgrade back on the local settings.
 *
 * Undefined when the site did not opt in, which is what switches every read and write off.
 */
export function buildRemoteSamplingStoreKey(initConfiguration: RumInitConfiguration): string | undefined {
  if (!initConfiguration.remoteConfiguration) {
    return undefined
  }

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
