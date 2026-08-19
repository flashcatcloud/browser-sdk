import { INTAKE_SITE_US1, noop, Observable, ONE_SECOND } from '@flashcatcloud/browser-core'
import { interceptRequests, registerCleanupTask } from '@flashcatcloud/browser-core/test'
import { mockRumConfiguration } from '../../../test'
import type { RumConfiguration, RumInitConfiguration } from './configuration'
import {
  buildRemoteSamplingSetup,
  readRemoteSampling,
  shouldRefreshOnActivation,
  startRemoteConfiguration,
} from './remoteConfiguration'

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
  activation = 'next_session',
  rum = {} as Record<string, number>,
  enabled = true,
  ttl = 300,
  refreshOnForeground = false,
  custom = undefined as Record<string, unknown> | undefined,
} = {}) {
  return JSON.stringify({ version: 3, ttl, enabled, activation, refresh_on_foreground: refreshOnForeground, rum, custom })
}

describe('remoteConfiguration', () => {
  let interceptor: ReturnType<typeof interceptRequests>
  let setup: ReturnType<typeof buildRemoteSamplingSetup>
  let pageActivationObservable: Observable<void>

  beforeEach(() => {
    interceptor = interceptRequests()
    setup = buildRemoteSamplingSetup(INIT_CONFIGURATION)
    pageActivationObservable = new Observable<void>()
    registerCleanupTask(() => localStorage.removeItem(setup!.storeKey))
  })

  function start(configuration: RumConfiguration, endCurrentSession: () => void = noop) {
    return startRemoteConfiguration(configuration, endCurrentSession, pageActivationObservable)
  }

  describe('opting in', () => {
    it('does nothing at all when the site did not opt in', () => {
      let requested = false
      interceptor.withMockXhr(() => {
        requested = true
      })

      start(mockRumConfiguration({ remoteSampling: undefined }), noop)

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
      start(configurationWith(), noop)
    })

    it('keeps a zero rate, which is a deliberate setting and not a missing one', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 0 } }))

        expect(readRemoteSampling(setup)).toEqual({ sessionSampleRate: 0, version: 3 })
        done()
      })
      start(configurationWith(), noop)
    })

    it('leaves out a rate the server did not report, so it stays with the value passed to init', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 42 } }))

        expect(readRemoteSampling(setup).sessionReplaySampleRate).toBeUndefined()
        done()
      })
      start(configurationWith(), noop)
    })

    it('keeps the custom bag the server reports, verbatim', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: {}, custom: { viplist: ['u-1', 'u-2'], debug: true } }))

        expect(readRemoteSampling(setup).custom).toEqual({ viplist: ['u-1', 'u-2'], debug: true })
        done()
      })
      start(configurationWith(), noop)
    })

    it('forgets the custom bag when the kill switch is off', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ custom: { debug: true } }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ enabled: false, custom: { debug: true } }))

        expect(readRemoteSampling(setup).custom).toBeUndefined()
        done()
      })
      start(configurationWith(), noop)
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
      start(configurationWith(), noop)
    })
  })

  describe('when the endpoint cannot be reached', () => {
    it('leaves the rates it already had alone rather than falling back to init', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(500)

        expect(readRemoteSampling(setup)).toEqual({ sessionSampleRate: 42 })
        done()
      })
      start(configurationWith(), noop)
    })

    it('leaves the rates alone when the body makes no sense', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, 'not json')

        expect(readRemoteSampling(setup)).toEqual({ sessionSampleRate: 42 })
        done()
      })
      start(configurationWith(), noop)
    })
  })

  describe('activation', () => {
    it('leaves the running session alone by default, however much the rates changed', (done) => {
      let ended = false
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ activation: 'next_session', rum: { sessionSampleRate: 100 } }))

        expect(ended).toBeFalse()
        done()
      })
      start(configurationWith(), () => {
        ended = true
      })
    })

    it('ends the running session when asked to activate immediately and the rates changed', (done) => {
      let ended = false
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ activation: 'immediate', rum: { sessionSampleRate: 100 } }))

        expect(ended).toBeTrue()
        done()
      })
      start(configurationWith(), () => {
        ended = true
      })
    })

    it('leaves the session alone when immediate rates match what this client already draws with', (done) => {
      // The console can send the same numbers the site passed to init, or resend an unchanged
      // configuration on every poll. Neither is a change, and neither may cost a visitor a session.
      let ended = false
      interceptor.withMockXhr((xhr) => {
        xhr.complete(
          200,
          body({ activation: 'immediate', rum: { sessionSampleRate: 10, sessionReplaySampleRate: 20 } })
        )

        expect(ended).toBeFalse()
        done()
      })
      start(configurationWith(), () => {
        ended = true
      })
    })

    it('ends the running session when only the replay rate changed', (done) => {
      let ended = false
      interceptor.withMockXhr((xhr) => {
        xhr.complete(
          200,
          body({ activation: 'immediate', rum: { sessionSampleRate: 10, sessionReplaySampleRate: 90 } })
        )

        expect(ended).toBeTrue()
        done()
      })
      start(configurationWith(), () => {
        ended = true
      })
    })

    it('ends the running session when the kill switch takes the rates away', (done) => {
      // Going back to the init rates is as much a change as any other, and switching remote
      // configuration off during an incident is exactly when it should not have to wait.
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 100 }))

      let ended = false
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ activation: 'immediate', enabled: false }))

        expect(ended).toBeTrue()
        done()
      })
      start(configurationWith(), () => {
        ended = true
      })
    })

    it('leaves the session alone when the request fails, whatever activation was last seen', (done) => {
      let ended = false
      interceptor.withMockXhr((xhr) => {
        xhr.complete(500)

        expect(ended).toBeFalse()
        done()
      })
      start(configurationWith(), () => {
        ended = true
      })
    })
  })

  describe('coming back to the page', () => {
    // Tested through the decision rather than by counting requests: the poll interval and the age
    // at which settings count as stale are the same duration by construction, so any clock tick
    // that makes them stale also fires the poll, and a request count cannot tell the two apart.
    it('asks again only when the server allowed it and the settings went stale', () => {
      expect(shouldRefreshOnActivation(true, 61 * ONE_SECOND, 60 * ONE_SECOND)).toBeTrue()
    })

    it('asks nothing when the server did not allow it', () => {
      // Off by default on purpose: coming back bunches requests at the moments people return to
      // their tabs, which is the shape the endpoint copes with worst.
      expect(shouldRefreshOnActivation(false, 61 * ONE_SECOND, 60 * ONE_SECOND)).toBeFalse()
    })

    it('asks nothing while the settings are still fresh', () => {
      expect(shouldRefreshOnActivation(true, 10 * ONE_SECOND, 60 * ONE_SECOND)).toBeFalse()
    })

    it('is wired to the page coming back, and stays quiet on a fresh page', (done) => {
      let requests = 0
      interceptor.withMockXhr((xhr) => {
        requests++
        xhr.complete(200, body({ refreshOnForeground: true }))

        pageActivationObservable.notify()

        expect(requests).toBe(1)
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
  })
})
