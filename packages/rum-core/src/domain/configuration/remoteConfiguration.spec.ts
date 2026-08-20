import { INTAKE_SITE_US1, ONE_SECOND } from '@flashcatcloud/browser-core'
import type { Clock, MockXhr } from '@flashcatcloud/browser-core/test'
import { interceptRequests, mockClock, registerCleanupTask } from '@flashcatcloud/browser-core/test'
import { mockRumConfiguration } from '../../../test'
import { LifeCycle, LifeCycleEventType } from '../lifeCycle'
import type { RumConfiguration, RumInitConfiguration } from './configuration'
import { buildRemoteSamplingSetup, readRemoteSampling, startRemoteConfiguration } from './remoteConfiguration'

const INIT_CONFIGURATION = {
  clientToken: 'token',
  applicationId: 'app',
  site: INTAKE_SITE_US1,
  env: 'staging',
  version: '1.2.3',
  remoteConfiguration: true,
} as RumInitConfiguration

function configurationWith(partial: Partial<RumConfiguration> = {}) {
  return mockRumConfiguration({
    sessionSampleRate: 10,
    sessionReplaySampleRate: 20,
    remoteSampling: buildRemoteSamplingSetup(INIT_CONFIGURATION),
    ...partial,
  })
}

function body({
  rum = {} as Record<string, number>,
  enabled = true,
  custom = undefined as Record<string, unknown> | undefined,
} = {}) {
  return JSON.stringify({
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
  let setup: ReturnType<typeof buildRemoteSamplingSetup>
  let lifeCycle: LifeCycle

  beforeEach(() => {
    interceptor = interceptRequests()
    setup = buildRemoteSamplingSetup(INIT_CONFIGURATION)
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

      start(mockRumConfiguration({ remoteSampling: undefined }))

      expect(requested).toBeFalse()
      expect(buildRemoteSamplingSetup({ ...INIT_CONFIGURATION, remoteConfiguration: false })).toBeUndefined()
      expect(readRemoteSampling(undefined)).toEqual({})
    })
  })

  describe('storing what the server sends', () => {
    it('keeps the rates the server reports', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 42, sessionReplaySampleRate: 7 } }))

        expect(readRemoteSampling(setup)).toEqual({ sessionSampleRate: 42, sessionReplaySampleRate: 7, version: 3 })
        done()
      })
      start(configurationWith())
    })

    it('keeps a zero rate, which is a deliberate setting and not a missing one', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 0 } }))

        expect(readRemoteSampling(setup)).toEqual({ sessionSampleRate: 0, version: 3 })
        done()
      })
      start(configurationWith())
    })

    it('leaves out a rate the server did not report, so it stays with the value passed to init', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 42 } }))

        expect(readRemoteSampling(setup).sessionReplaySampleRate).toBeUndefined()
        done()
      })
      start(configurationWith())
    })

    it('keeps the custom bag the server reports, verbatim', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: {}, custom: { viplist: ['u-1', 'u-2'], debug: true } }))

        expect(readRemoteSampling(setup).custom).toEqual({ viplist: ['u-1', 'u-2'], debug: true })
        done()
      })
      start(configurationWith())
    })

    it('forgets the custom bag when the kill switch is off', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ custom: { debug: true } }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ enabled: false, custom: { debug: true } }))

        expect(readRemoteSampling(setup).custom).toBeUndefined()
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
        expect(readRemoteSampling(setup)).toEqual({ version: 3 })
        done()
      })
      start(configurationWith())
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

    it('leaves the rates it already had alone rather than falling back to init', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(500)

        expect(readRemoteSampling(setup)).toEqual({ sessionSampleRate: 42 })
        done()
      })
      start(configurationWith())
    })

    it('leaves the rates alone when the body makes no sense', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, 'not json')

        expect(readRemoteSampling(setup)).toEqual({ sessionSampleRate: 42 })
        done()
      })
      start(configurationWith())
    })
  })

  describe('telling the server what it is running', () => {
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
  })

  describe('the storage key', () => {
    it('separates applications, environments and versions', () => {
      const keyOf = (partial: Partial<RumInitConfiguration>) =>
        buildRemoteSamplingSetup({ ...INIT_CONFIGURATION, ...partial })!.storeKey

      expect(keyOf({})).not.toEqual(keyOf({ applicationId: 'other' }))
      expect(keyOf({})).not.toEqual(keyOf({ env: 'production' }))
      expect(keyOf({})).not.toEqual(keyOf({ version: '1.2.4' }))
    })

    it('carries the storage format version, so only a format change orphans the cache', () => {
      expect(buildRemoteSamplingSetup(INIT_CONFIGURATION)!.storeKey.startsWith('_fc_rc_1_')).toBeTrue()
    })
  })
})
