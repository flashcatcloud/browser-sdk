import { INTAKE_SITE_US1, noop } from '@flashcatcloud/browser-core'
import { interceptRequests, registerCleanupTask } from '@flashcatcloud/browser-core/test'
import { mockRumConfiguration } from '../../../test'
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

function body({ activation = 'next_session', rum = {} as Record<string, number>, enabled = true } = {}) {
  return JSON.stringify({ version: 3, ttl: 300, enabled, activation, rum })
}

describe('remoteConfiguration', () => {
  let interceptor: ReturnType<typeof interceptRequests>
  let setup: ReturnType<typeof buildRemoteSamplingSetup>

  beforeEach(() => {
    interceptor = interceptRequests()
    setup = buildRemoteSamplingSetup(INIT_CONFIGURATION)
    registerCleanupTask(() => localStorage.removeItem(setup!.storeKey))
  })

  describe('opting in', () => {
    it('does nothing at all when the site did not opt in', () => {
      let requested = false
      interceptor.withMockXhr(() => {
        requested = true
      })

      startRemoteConfiguration(mockRumConfiguration({ remoteSampling: undefined }), noop)

      expect(requested).toBeFalse()
      expect(buildRemoteSamplingSetup({ ...INIT_CONFIGURATION, remoteConfiguration: false })).toBeUndefined()
      expect(readRemoteSampling(undefined)).toEqual({})
    })
  })

  describe('storing what the server sends', () => {
    it('keeps the rates the server reports', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 42, sessionReplaySampleRate: 7 } }))

        expect(readRemoteSampling(setup)).toEqual({ sessionSampleRate: 42, sessionReplaySampleRate: 7 })
        done()
      })
      startRemoteConfiguration(configurationWith(), noop)
    })

    it('keeps a zero rate, which is a deliberate setting and not a missing one', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 0 } }))

        expect(readRemoteSampling(setup)).toEqual({ sessionSampleRate: 0 })
        done()
      })
      startRemoteConfiguration(configurationWith(), noop)
    })

    it('leaves out a rate the server did not report, so it stays with the value passed to init', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 42 } }))

        expect(readRemoteSampling(setup).sessionReplaySampleRate).toBeUndefined()
        done()
      })
      startRemoteConfiguration(configurationWith(), noop)
    })

    it('forgets the rates once remote configuration is switched off', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ enabled: false }))

        expect(readRemoteSampling(setup)).toEqual({})
        done()
      })
      startRemoteConfiguration(configurationWith(), noop)
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
      startRemoteConfiguration(configurationWith(), noop)
    })

    it('leaves the rates alone when the body makes no sense', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, 'not json')

        expect(readRemoteSampling(setup)).toEqual({ sessionSampleRate: 42 })
        done()
      })
      startRemoteConfiguration(configurationWith(), noop)
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
      startRemoteConfiguration(configurationWith(), () => {
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
      startRemoteConfiguration(configurationWith(), () => {
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
      startRemoteConfiguration(configurationWith(), () => {
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
      startRemoteConfiguration(configurationWith(), () => {
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
      startRemoteConfiguration(configurationWith(), () => {
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
      startRemoteConfiguration(configurationWith(), () => {
        ended = true
      })
    })
  })

  describe('the request', () => {
    it('goes to the config endpoint on the same host as the intake, carrying what rules match on', (done) => {
      interceptor.withMockXhr((xhr) => {
        expect(xhr.url).toContain(`https://${INTAKE_SITE_US1}/api/v2/rum/config?`)
        expect(xhr.url).toContain('client_token=token')
        expect(xhr.url).toContain('sdk=web')
        expect(xhr.url).toContain('env=staging')
        expect(xhr.url).toContain('app_version=1.2.3')
        done()
      })
      startRemoteConfiguration(configurationWith(), noop)
    })

    it('goes through the customer proxy when there is one, like every other request', (done) => {
      interceptor.withMockXhr((xhr) => {
        expect(xhr.url).toContain('https://proxy.example.com/path?ddforward=')
        expect(decodeURIComponent(xhr.url!)).toContain('/api/v2/rum/config?')
        done()
      })
      startRemoteConfiguration(
        configurationWith({
          remoteSampling: buildRemoteSamplingSetup({
            ...INIT_CONFIGURATION,
            proxy: 'https://proxy.example.com/path',
          }),
        }),
        noop
      )
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
