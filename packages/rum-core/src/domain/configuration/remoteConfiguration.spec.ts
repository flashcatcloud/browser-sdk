import { INTAKE_SITE_US1 } from '@flashcatcloud/browser-core'
import { interceptRequests, registerCleanupTask } from '@flashcatcloud/browser-core/test'
import type { RumInitConfiguration } from './configuration'
import { buildRemoteSamplingStoreKey, readRemoteSampling, startRemoteConfiguration } from './remoteConfiguration'

const INIT_CONFIGURATION = {
  clientToken: 'token',
  applicationId: 'app',
  site: INTAKE_SITE_US1,
  env: 'staging',
  version: '1.2.3',
  remoteConfiguration: true,
} as RumInitConfiguration

function storeKeyOf(initConfiguration: RumInitConfiguration) {
  return buildRemoteSamplingStoreKey(initConfiguration)!
}

describe('remoteConfiguration', () => {
  let interceptor: ReturnType<typeof interceptRequests>

  beforeEach(() => {
    interceptor = interceptRequests()
    registerCleanupTask(() => localStorage.removeItem(storeKeyOf(INIT_CONFIGURATION)))
  })

  describe('opting in', () => {
    it('does nothing at all when the site did not opt in', () => {
      const initConfiguration = { ...INIT_CONFIGURATION, remoteConfiguration: false }
      let requested = false
      interceptor.withMockXhr(() => {
        requested = true
      })

      startRemoteConfiguration(initConfiguration)

      expect(requested).toBeFalse()
      expect(buildRemoteSamplingStoreKey(initConfiguration)).toBeUndefined()
      expect(readRemoteSampling(buildRemoteSamplingStoreKey(initConfiguration))).toEqual({})
    })
  })

  describe('storing what the server sends', () => {
    it('keeps the rates the server reports', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(
          200,
          '{"version":3,"ttl":300,"enabled":true,"rum":{"sessionSampleRate":42,"sessionReplaySampleRate":7}}'
        )

        expect(readRemoteSampling(storeKeyOf(INIT_CONFIGURATION))).toEqual({
          sessionSampleRate: 42,
          sessionReplaySampleRate: 7,
        })
        done()
      })
      startRemoteConfiguration(INIT_CONFIGURATION)
    })

    it('keeps a zero rate, which is a deliberate setting and not a missing one', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, '{"version":3,"ttl":300,"enabled":true,"rum":{"sessionSampleRate":0}}')

        expect(readRemoteSampling(storeKeyOf(INIT_CONFIGURATION))).toEqual({ sessionSampleRate: 0 })
        done()
      })
      startRemoteConfiguration(INIT_CONFIGURATION)
    })

    it('leaves out a rate the server did not report, so it stays with the value passed to init', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, '{"version":3,"ttl":300,"enabled":true,"rum":{"sessionSampleRate":42}}')

        expect(readRemoteSampling(storeKeyOf(INIT_CONFIGURATION)).sessionReplaySampleRate).toBeUndefined()
        done()
      })
      startRemoteConfiguration(INIT_CONFIGURATION)
    })

    it('forgets the rates once remote configuration is switched off', (done) => {
      localStorage.setItem(storeKeyOf(INIT_CONFIGURATION), JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, '{"version":4,"ttl":300,"enabled":false,"rum":{}}')

        expect(readRemoteSampling(storeKeyOf(INIT_CONFIGURATION))).toEqual({})
        done()
      })
      startRemoteConfiguration(INIT_CONFIGURATION)
    })
  })

  describe('when the endpoint cannot be reached', () => {
    it('leaves the rates it already had alone rather than falling back to init', (done) => {
      localStorage.setItem(storeKeyOf(INIT_CONFIGURATION), JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(500)

        expect(readRemoteSampling(storeKeyOf(INIT_CONFIGURATION))).toEqual({ sessionSampleRate: 42 })
        done()
      })
      startRemoteConfiguration(INIT_CONFIGURATION)
    })

    it('leaves the rates alone when the body makes no sense', (done) => {
      localStorage.setItem(storeKeyOf(INIT_CONFIGURATION), JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, 'not json')

        expect(readRemoteSampling(storeKeyOf(INIT_CONFIGURATION))).toEqual({ sessionSampleRate: 42 })
        done()
      })
      startRemoteConfiguration(INIT_CONFIGURATION)
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
      startRemoteConfiguration(INIT_CONFIGURATION)
    })

    it('goes through the customer proxy when there is one, like every other request', (done) => {
      interceptor.withMockXhr((xhr) => {
        expect(xhr.url).toContain('https://proxy.example.com/path?ddforward=')
        expect(decodeURIComponent(xhr.url!)).toContain('/api/v2/rum/config?')
        done()
      })
      startRemoteConfiguration({ ...INIT_CONFIGURATION, proxy: 'https://proxy.example.com/path' })
    })
  })

  describe('the storage key', () => {
    it('separates applications, environments and versions', () => {
      const key = storeKeyOf(INIT_CONFIGURATION)

      expect(key).not.toEqual(storeKeyOf({ ...INIT_CONFIGURATION, applicationId: 'other' }))
      expect(key).not.toEqual(storeKeyOf({ ...INIT_CONFIGURATION, env: 'production' }))
      expect(key).not.toEqual(storeKeyOf({ ...INIT_CONFIGURATION, version: '1.2.4' }))
    })
  })
})
