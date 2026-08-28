import { INTAKE_SITE_US1, ONE_SECOND } from '@flashcatcloud/browser-core'
import type { Clock, MockXhr } from '@flashcatcloud/browser-core/test'
import { interceptRequests, mockClock, registerCleanupTask } from '@flashcatcloud/browser-core/test'
import { mockRumConfiguration } from '../../../test'
import { LifeCycle, LifeCycleEventType } from '../lifeCycle'
import type { RumConfiguration, RumInitConfiguration } from './configuration'
import {
  buildDrawStoreKey,
  buildRemoteConfigSetup,
  readRemoteConfig,
  startRemoteConfiguration,
} from './remoteConfiguration'

const INIT_CONFIGURATION = {
  clientToken: 'token',
  applicationId: 'app',
  site: INTAKE_SITE_US1,
  env: 'staging',
  version: '1.2.3',
  remoteConfigurationEnabled: true,
} as RumInitConfiguration

function configurationWith(partial: Partial<RumConfiguration> = {}) {
  return mockRumConfiguration({
    sessionSampleRate: 10,
    sessionReplaySampleRate: 20,
    remoteConfig: buildRemoteConfigSetup(INIT_CONFIGURATION),
    ...partial,
  })
}

function body({
  rum = {} as Record<string, unknown>,
  enabled = true,
  custom = undefined as Record<string, unknown> | undefined,
  schemaVersion = 1 as number | undefined,
} = {}) {
  return JSON.stringify({
    schema_version: schemaVersion,
    version: 3,
    ttl: 600,
    enabled,
    activation: 'next_session',
    rum,
    custom,
  })
}

describe('remoteConfiguration', () => {
  let interceptor: ReturnType<typeof interceptRequests>
  let setup: ReturnType<typeof buildRemoteConfigSetup>
  let lifeCycle: LifeCycle

  beforeEach(() => {
    interceptor = interceptRequests()
    setup = buildRemoteConfigSetup(INIT_CONFIGURATION)
    lifeCycle = new LifeCycle()
    registerCleanupTask(() => localStorage.removeItem(setup!.storeKey))
  })

  function start(configuration: RumConfiguration) {
    const stop = startRemoteConfiguration(configuration, lifeCycle)
    registerCleanupTask(stop)
    return stop
  }

  describe('opting in', () => {
    it('does nothing at all when the site did not opt in', () => {
      let requested = false
      interceptor.withMockXhr(() => {
        requested = true
      })

      start(mockRumConfiguration({ remoteConfig: undefined }))

      expect(requested).toBeFalse()
      expect(buildRemoteConfigSetup({ ...INIT_CONFIGURATION, remoteConfigurationEnabled: false })).toBeUndefined()
      expect(readRemoteConfig(undefined)).toEqual({})
    })
  })

  describe('storing what the server sends', () => {
    it('keeps the rates the server reports', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 42, sessionReplaySampleRate: 7 } }))

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 42, sessionReplaySampleRate: 7, version: 3 })
        done()
      })
      start(configurationWith())
    })

    it('keeps a zero rate, which is a deliberate setting and not a missing one', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 0 } }))

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 0, version: 3 })
        done()
      })
      start(configurationWith())
    })

    it('leaves out a rate the server did not report, so it stays with the value passed to init', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 42 } }))

        expect(readRemoteConfig(setup).sessionReplaySampleRate).toBeUndefined()
        done()
      })
      start(configurationWith())
    })

    it('keeps the trace rate and the privacy level the server reports', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { traceSampleRate: 25, defaultPrivacyLevel: 'allow' } }))

        expect(readRemoteConfig(setup)).toEqual({ traceSampleRate: 25, defaultPrivacyLevel: 'allow', version: 3 })
        done()
      })
      start(configurationWith())
    })

    it('drops a privacy level it does not recognise rather than passing it on', (done) => {
      // A typo must not reach the recorders: an unknown value there falls through to recording
      // everything, which is the one outcome nobody asks for by accident.
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 50, defaultPrivacyLevel: 'masked' } }))

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 50, version: 3 })
        done()
      })
      start(configurationWith())
    })

    it('keeps the custom bag the server reports, verbatim', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: {}, custom: { viplist: ['u-1', 'u-2'], debug: true } }))

        expect(readRemoteConfig(setup).custom).toEqual({ viplist: ['u-1', 'u-2'], debug: true })
        done()
      })
      start(configurationWith())
    })

    it('forgets the custom bag when the kill switch is off', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ custom: { debug: true } }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ enabled: false, custom: { debug: true } }))

        expect(readRemoteConfig(setup).custom).toBeUndefined()
        done()
      })
      start(configurationWith())
    })

    it('forgets the rates once remote configuration is switched off', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ enabled: false }))

        // The rates are gone, but the version is kept: the console still needs to see that this
        // client is up to date with the change that turned them off.
        expect(readRemoteConfig(setup)).toEqual({ version: 3 })
        done()
      })
      start(configurationWith())
    })
  })

  describe('refusing a payload it cannot read', () => {
    const STORED = { sessionSampleRate: 42, version: 2 }

    beforeEach(() => localStorage.setItem(setup!.storeKey, JSON.stringify(STORED)))

    it('keeps the settings in force when the schema version is one this build does not know', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 5 }, schemaVersion: 2 }))

        // Not applied and not stored: a shape this build may misread must not reach the recorders,
        // and must not evict what is already working.
        expect(readRemoteConfig(setup)).toEqual(STORED)
        done()
      })
      start(configurationWith())
    })

    it('accepts a response from a server too old to stamp a schema version', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 5 }, schemaVersion: undefined }))

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 5, version: 3 })
        done()
      })
      start(configurationWith())
    })

    it('keeps the settings in force when a 200 carries something that is not a configuration', (done) => {
      interceptor.withMockXhr((xhr) => {
        // A captive portal or a gateway error page answering 200. Storing it would blank the cache
        // and drop the whole fleet back to its init settings.
        xhr.complete(200, '{}')

        expect(readRemoteConfig(setup)).toEqual(STORED)
        done()
      })
      start(configurationWith())
    })
  })

  describe('reading storage back', () => {
    // Storage is not ours alone: it survives an SDK downgrade, it is shared with everything else on
    // the origin, and anyone can edit it in devtools. A value that is not usable has to read as
    // "nothing was delivered" so the site's own settings stay in force.
    it('ignores a rate that is not a number', () => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 'lots', version: 2 }))

      expect(readRemoteConfig(setup)).toEqual({ version: 2 })
    })

    it('ignores a rate outside the range a rate can take', () => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 140, version: 2 }))

      expect(readRemoteConfig(setup)).toEqual({ version: 2 })
    })

    it('ignores a privacy level it does not recognise', () => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ defaultPrivacyLevel: 'off', version: 2 }))

      expect(readRemoteConfig(setup)).toEqual({ version: 2 })
    })

    it('keeps the values either side of a bad one', () => {
      localStorage.setItem(
        setup!.storeKey,
        JSON.stringify({ sessionSampleRate: 42, sessionReplaySampleRate: null, traceSampleRate: 7, version: 2 })
      )

      expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 42, traceSampleRate: 7, version: 2 })
    })

    it('reads nothing at all out of a value that is not an object', () => {
      localStorage.setItem(setup!.storeKey, '"a string"')

      expect(readRemoteConfig(setup)).toEqual({})
    })
  })

  describe('fetching cadence', () => {
    // No polling: the rates only matter at the next draw, so the SDK asks once at start-up and
    // once per session renewal, and stays quiet in between.
    let clock: Clock

    beforeEach(() => {
      clock = mockClock()
      registerCleanupTask(() => clock.cleanup())
    })

    it('fetches once at start-up and stays quiet afterwards', () => {
      const requests: MockXhr[] = []
      interceptor.withMockXhr((xhr) => {
        requests.push(xhr)
        xhr.complete(200, body())
      })

      start(configurationWith())
      clock.tick(60 * 60 * ONE_SECOND)

      expect(requests.length).toBe(1)
    })

    it('fetches again when a session is renewed', () => {
      const requests: MockXhr[] = []
      interceptor.withMockXhr((xhr) => {
        requests.push(xhr)
        xhr.complete(200, body())
      })

      start(configurationWith())
      lifeCycle.notify(LifeCycleEventType.SESSION_RENEWED)

      expect(requests.length).toBe(2)
    })

    it('retries a failure quickly, then patiently, then gives up until the next trigger', () => {
      const requests: MockXhr[] = []
      interceptor.withMockXhr((xhr) => {
        requests.push(xhr)
        xhr.complete(500)
      })

      start(configurationWith())
      expect(requests.length).toBe(1)

      // First retry lands within 5s ± jitter.
      clock.tick(6 * ONE_SECOND + ONE_SECOND)
      expect(requests.length).toBe(2)

      // Second retry lands within 60s ± jitter.
      clock.tick(72 * ONE_SECOND + ONE_SECOND)
      expect(requests.length).toBe(3)

      // Budget exhausted: no matter how long the page sits there, nothing more is asked.
      clock.tick(60 * 60 * ONE_SECOND)
      expect(requests.length).toBe(3)

      // The next natural trigger starts a fresh attempt (with a fresh retry budget).
      lifeCycle.notify(LifeCycleEventType.SESSION_RENEWED)
      expect(requests.length).toBe(4)
    })

    it('asks for nothing more once it has been stopped', () => {
      const requests: MockXhr[] = []
      // Left in flight on purpose: the answer arrives after the SDK has been stopped, which is the
      // only moment at which a retry can be scheduled past the cleanup that was meant to prevent it.
      interceptor.withMockXhr((xhr) => requests.push(xhr))

      const stop = start(configurationWith())
      expect(requests.length).toBe(1)

      stop()
      requests[0].complete(500)
      clock.tick(6 * ONE_SECOND + ONE_SECOND)
      clock.tick(72 * ONE_SECOND + ONE_SECOND)

      expect(requests.length).toBe(1)
    })

    it('leaves the rates it already had alone rather than falling back to init', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(500)

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 42 })
        done()
      })
      start(configurationWith())
    })

    it('leaves the rates alone when the body makes no sense', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, 'not json')

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 42 })
        done()
      })
      start(configurationWith())
    })
  })

  describe('telling the server what it is running', () => {
    it('identifies which SDK build is asking', (done) => {
      interceptor.withMockXhr((xhr) => {
        // Sent from the first release on: a rule targeting a particular build cannot be written
        // later, because the clients it would have to match are already deployed.
        expect(xhr.url).toContain('sdk=web')
        expect(xhr.url).toContain('sdk_version=')
        done()
      })
      start(configurationWith())
    })

    it('sends nothing the first time, when it is running nothing yet', (done) => {
      interceptor.withMockXhr((xhr) => {
        expect(xhr.url).not.toContain('applied_version')
        done()
      })
      start(configurationWith())
    })

    it('sends the stored version once it has one', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42, version: 17 }))

      interceptor.withMockXhr((xhr) => {
        // Sent on the request every client makes, kept or not, which is why it can answer "has my
        // change reached everyone" when the events cannot.
        expect(xhr.url).toContain('applied_version=17')
        done()
      })
      start(configurationWith())
    })

    it('sends a stored version of zero like any other', (done) => {
      // A console whose first published version is numbered 0. Reporting nothing for it would show
      // every client running it as one that never applied the change.
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42, version: 0 }))

      interceptor.withMockXhr((xhr) => {
        expect(xhr.url).toContain('applied_version=0')
        done()
      })
      start(configurationWith())
    })

    it('sends it inside the forwarded request when the site uses a proxy', (done) => {
      const proxied = buildRemoteConfigSetup({ ...INIT_CONFIGURATION, proxy: 'https://proxy.example.com/rum' })
      localStorage.setItem(proxied!.storeKey, JSON.stringify({ version: 17 }))
      registerCleanupTask(() => localStorage.removeItem(proxied!.storeKey))

      interceptor.withMockXhr((xhr) => {
        // A proxy forwards what its `ddforward` parameter holds and nothing else, so a version
        // appended to the finished URL would be read by the proxy and stop there.
        const forwarded = new URL(xhr.url!).searchParams.get('ddforward')!
        expect(forwarded).toContain('applied_version=17')
        done()
      })
      start(configurationWith({ remoteConfig: proxied }))
    })
  })

  describe('the storage key', () => {
    it('separates applications, environments and versions', () => {
      const keyOf = (partial: Partial<RumInitConfiguration>) =>
        buildRemoteConfigSetup({ ...INIT_CONFIGURATION, ...partial })!.storeKey

      expect(keyOf({})).not.toEqual(keyOf({ applicationId: 'other' }))
      expect(keyOf({})).not.toEqual(keyOf({ env: 'production' }))
      expect(keyOf({})).not.toEqual(keyOf({ version: '1.2.4' }))
    })

    it('carries the storage format version, so only a format change orphans the cache', () => {
      expect(buildRemoteConfigSetup(INIT_CONFIGURATION)!.storeKey.startsWith('_fc_rc_1_')).toBeTrue()
    })

    it('keys the draw record by application and environment, but not by application version', () => {
      // The record belongs to the session, and a session outlives a deploy: keying it by version
      // would lose the decision the moment a visitor with a live session lands on a new release.
      const keyOf = (partial: Partial<RumInitConfiguration>) => buildDrawStoreKey({ ...INIT_CONFIGURATION, ...partial })

      expect(keyOf({})).not.toEqual(keyOf({ applicationId: 'other' }))
      expect(keyOf({})).not.toEqual(keyOf({ env: 'production' }))
      expect(keyOf({})).toEqual(keyOf({ version: '1.2.4' }))
      expect(keyOf({})).not.toEqual(buildRemoteConfigSetup(INIT_CONFIGURATION)!.storeKey)
    })
  })
})
