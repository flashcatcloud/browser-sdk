import {
  INTAKE_SITE_US1,
  ONE_SECOND,
  TrackingConsent,
  createTrackingConsentState,
  deleteCookie,
  getCookie,
  isIntakeUrl,
} from '@flashcatcloud/browser-core'
import type { MockXhr } from '@flashcatcloud/browser-core/test'
import {
  createNewEvent,
  interceptRequests,
  mockSyntheticsWorkerValues,
  mockClock,
  mockEventBridge,
  registerCleanupTask,
  restorePageVisibility,
  setPageVisibility,
} from '@flashcatcloud/browser-core/test'
import { createRumSessionManagerMock, mockRumConfiguration } from '../../test'
import { buildActivePingSetup, startActivePing } from './activePing'
import type { RumConfiguration, RumInitConfiguration } from './configuration'
import { buildUserContextManager } from './contexts/userContext'
import { LifeCycle, LifeCycleEventType } from './lifeCycle'

const INIT_CONFIGURATION = {
  clientToken: 'token',
  applicationId: 'app',
  site: INTAKE_SITE_US1,
  env: 'staging',
  version: '1.2.3',
  service: 'shop',
  // Most specs assert on the stored state directly; the cookie store is covered separately.
  sessionPersistence: 'local-storage',
} as RumInitConfiguration

describe('activePing', () => {
  let requests: MockXhr[]
  let lifeCycle: LifeCycle
  let sessionManager: ReturnType<typeof createRumSessionManagerMock>
  let userContext: ReturnType<typeof buildUserContextManager>
  let trackingConsentState: ReturnType<typeof createTrackingConsentState>

  function configurationWith(partial: Partial<RumConfiguration> = {}) {
    return mockRumConfiguration({
      activePing: buildActivePingSetup(INIT_CONFIGURATION),
      trackAnonymousUser: true,
      service: 'shop',
      version: '1.2.3',
      ...partial,
    })
  }

  function start(configuration: RumConfiguration = configurationWith()) {
    const activePing = startActivePing(configuration, lifeCycle, sessionManager, userContext, trackingConsentState)
    registerCleanupTask(() => activePing.stop())
    return activePing
  }

  function payloadOf(xhr: MockXhr): Record<string, unknown> {
    return JSON.parse(xhr.body as string) as Record<string, unknown>
  }

  function storeKey() {
    return buildActivePingSetup(INIT_CONFIGURATION).storeKey
  }

  function startClock() {
    const clock = mockClock()
    registerCleanupTask(() => clock.cleanup())
    return clock
  }

  beforeEach(() => {
    requests = []
    interceptRequests().withMockXhr((xhr) => requests.push(xhr))
    lifeCycle = new LifeCycle()
    sessionManager = createRumSessionManagerMock()
    userContext = buildUserContextManager()
    trackingConsentState = createTrackingConsentState(TrackingConsent.GRANTED)
    setPageVisibility('visible')
    localStorage.removeItem(storeKey())
    deleteCookie(storeKey())
    registerCleanupTask(() => {
      localStorage.removeItem(storeKey())
      deleteCookie(storeKey())
      restorePageVisibility()
    })
  })

  describe('the report', () => {
    it('is sent once at start, carrying the anonymous id as the device', () => {
      start()

      expect(requests.length).toBe(1)
      expect(requests[0].url).toContain('/api/v2/rum/active')
      expect(requests[0].url).toContain('dd-api-key=token')
      // The SDK must recognise its own traffic and leave it out of what it collects.
      expect(isIntakeUrl(requests[0].url!)).toBeTrue()
      expect(payloadOf(requests[0])).toEqual(
        jasmine.objectContaining({
          service: 'shop',
          env: 'staging',
          version: '1.2.3',
          build_version: '',
          usr: { anonymous_id: 'device-123' },
          os: jasmine.objectContaining({ name: jasmine.any(String) }),
          device: jasmine.objectContaining({ type: jasmine.any(String) }),
          age_ms: 0,
        })
      )
    })

    it('is not sent again for a combination already reported today', () => {
      start()
      requests[0].complete(202)

      lifeCycle.notify(LifeCycleEventType.SESSION_RENEWED)

      expect(requests.length).toBe(1)
    })

    it('is sent again when a user logs in, with the raw user id', () => {
      start()
      requests[0].complete(202)

      userContext.setContext({ id: 'user-42' })

      expect(requests.length).toBe(2)
      expect(payloadOf(requests[1])).toEqual(
        jasmine.objectContaining({ usr: { anonymous_id: 'device-123', id: 'user-42' } })
      )
    })

    it('is sent for a session the sampling draw did not keep', () => {
      sessionManager.setNotTracked()

      start()

      expect(requests.length).toBe(1)
      expect(payloadOf(requests[0])).toEqual(jasmine.objectContaining({ usr: { anonymous_id: 'device-123' } }))
    })

    it('reports only the user when anonymous tracking is off', () => {
      start(configurationWith({ trackAnonymousUser: false }))
      expect(requests.length).toBe(0)

      userContext.setContext({ id: 'user-42' })

      expect(requests.length).toBe(1)
      expect(payloadOf(requests[0])).toEqual(jasmine.objectContaining({ usr: { id: 'user-42' } }))
    })

    it('waits for the page to be visible', () => {
      setPageVisibility('hidden')
      start()
      expect(requests.length).toBe(0)

      setPageVisibility('visible')
      document.dispatchEvent(createNewEvent('visibilitychange'))

      expect(requests.length).toBe(1)
    })
  })

  describe('when not to report', () => {
    it('sends nothing in a synthetics run, which is not a visitor', () => {
      mockSyntheticsWorkerValues()

      start()

      expect(requests.length).toBe(0)
    })

    it('sends nothing under an event bridge, where the host reports for itself', () => {
      mockEventBridge()

      start()

      expect(requests.length).toBe(0)
    })
  })

  describe('tracking consent', () => {
    it('sends and stores nothing before consent, then reports when it is granted', () => {
      trackingConsentState = createTrackingConsentState(TrackingConsent.NOT_GRANTED)

      start()

      expect(requests.length).toBe(0)
      expect(localStorage.getItem(storeKey())).toBeNull()

      trackingConsentState.update(TrackingConsent.GRANTED)

      expect(requests.length).toBe(1)
    })

    it('deletes undelivered reports when consent is withdrawn', () => {
      start()
      requests[0].complete(500)
      expect(localStorage.getItem(storeKey())).toContain('pending')

      trackingConsentState.update(TrackingConsent.NOT_GRANTED)

      expect(localStorage.getItem(storeKey())).toBeNull()
    })
  })

  describe('delivery', () => {
    it('retries a failed report and marks the combination sent once it lands', () => {
      const clock = startClock()
      start()
      requests[0].complete(500)

      clock.tick(10 * ONE_SECOND)

      expect(requests.length).toBe(2)
      requests[1].complete(202)
      const stored = JSON.parse(localStorage.getItem(storeKey())!)
      expect(stored.pending).toEqual([])
      expect(stored.sent.length).toBe(1)
    })

    it('keeps an undelivered report for the next page, with its age as age_ms', () => {
      const clock = startClock()
      const first = start()
      requests[0].complete(500)
      first.stop()

      clock.tick(30 * ONE_SECOND)
      start()

      expect(requests.length).toBe(2)
      expect(payloadOf(requests[1]).age_ms).toBe(30 * ONE_SECOND)
      // The same stored report across pages: the intake keeps one row per combination.
      expect(payloadOf(requests[1]).usr).toEqual(payloadOf(requests[0]).usr)
    })

    it('drops a report the server refuses about itself', () => {
      const clock = startClock()
      start()
      requests[0].complete(400)

      clock.tick(120 * ONE_SECOND)

      expect(requests.length).toBe(1)
      expect(JSON.parse(localStorage.getItem(storeKey())!).pending).toEqual([])
    })
  })

  describe('storage follows sessionPersistence', () => {
    function configurationWithPersistence(sessionPersistence: RumInitConfiguration['sessionPersistence']) {
      return configurationWith({
        activePing: buildActivePingSetup({ ...INIT_CONFIGURATION, sessionPersistence }),
      })
    }

    function storedCookieState() {
      const raw = getCookie(storeKey())
      return raw ? (JSON.parse(decodeURIComponent(raw)) as { sent: string[]; pending: unknown[] }) : undefined
    }

    it('keeps the state in a cookie when sessions are kept in a cookie, and deduplicates from it', () => {
      start(configurationWithPersistence('cookie'))
      requests[0].complete(202)

      expect(localStorage.getItem(storeKey())).toBeNull()
      expect(storedCookieState()?.sent.length).toBe(1)

      lifeCycle.notify(LifeCycleEventType.SESSION_RENEWED)

      expect(requests.length).toBe(1)
    })

    it('keeps an undelivered report in the cookie for the next page', () => {
      start(configurationWithPersistence('cookie'))
      requests[0].complete(500)

      expect(storedCookieState()?.pending.length).toBe(1)
    })

    it('uses the cookie store by default, as the session store does', () => {
      start(configurationWithPersistence(undefined))
      requests[0].complete(202)

      expect(localStorage.getItem(storeKey())).toBeNull()
      expect(storedCookieState()?.sent.length).toBe(1)
    })

    it('deletes the cookie state when consent is withdrawn', () => {
      start(configurationWithPersistence('cookie'))
      requests[0].complete(500)
      expect(getCookie(storeKey())).toBeTruthy()

      trackingConsentState.update(TrackingConsent.NOT_GRANTED)

      expect(getCookie(storeKey())).toBeUndefined()
    })
  })
})
