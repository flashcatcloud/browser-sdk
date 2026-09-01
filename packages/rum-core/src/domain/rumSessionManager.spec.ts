import type { RelativeTime, TrackingConsentState } from '@flashcatcloud/browser-core'
import {
  STORAGE_POLL_DELAY,
  SESSION_STORE_KEY,
  relativeNow,
  setCookie,
  stopSessionManager,
  ONE_SECOND,
  DOM_EVENT,
  createTrackingConsentState,
  TrackingConsent,
  BridgeCapability,
} from '@flashcatcloud/browser-core'
import type { Clock } from '@flashcatcloud/browser-core/test'
import {
  createNewEvent,
  expireCookie,
  getSessionState,
  mockEventBridge,
  mockClock,
  registerCleanupTask,
} from '@flashcatcloud/browser-core/test'
import { mockRumConfiguration } from '../../test'
import type { RumConfiguration } from './configuration'

import { LifeCycle, LifeCycleEventType } from './lifeCycle'
import {
  RUM_SESSION_KEY,
  RumTrackingType,
  SessionReplayState,
  STUB_SESSION_ID,
  startRumSessionManager,
  startRumSessionManagerStub,
} from './rumSessionManager'

describe('rum session manager', () => {
  const DURATION = 123456
  let lifeCycle: LifeCycle
  let expireSessionSpy: jasmine.Spy
  let renewSessionSpy: jasmine.Spy
  let clock: Clock

  beforeEach(() => {
    clock = mockClock()
    expireSessionSpy = jasmine.createSpy('expireSessionSpy')
    renewSessionSpy = jasmine.createSpy('renewSessionSpy')
    lifeCycle = new LifeCycle()
    lifeCycle.subscribe(LifeCycleEventType.SESSION_EXPIRED, expireSessionSpy)
    lifeCycle.subscribe(LifeCycleEventType.SESSION_RENEWED, renewSessionSpy)

    registerCleanupTask(() => {
      // Tests that do not name their own key write the record of their draw to the default one.
      localStorage.removeItem(mockRumConfiguration().drawStoreKey)
      // remove intervals first
      stopSessionManager()
      // flush pending callbacks to avoid random failures
      clock.tick(new Date().getTime())
      clock.cleanup()
    })
  })

  describe('cookie storage', () => {
    it('when tracked with session replay should store session type and id', () => {
      startRumSessionManagerWithDefaults({ configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 100 } })

      expect(expireSessionSpy).not.toHaveBeenCalled()
      expect(renewSessionSpy).not.toHaveBeenCalled()

      expect(getSessionState(SESSION_STORE_KEY).id).toMatch(/[a-f0-9-]/)
      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
    })

    it('when tracked without session replay should store session type and id', () => {
      startRumSessionManagerWithDefaults({ configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 0 } })

      expect(expireSessionSpy).not.toHaveBeenCalled()
      expect(renewSessionSpy).not.toHaveBeenCalled()
      expect(getSessionState(SESSION_STORE_KEY).id).toMatch(/[a-f0-9-]/)
      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY)
    })

    it('when not tracked should store session type', () => {
      startRumSessionManagerWithDefaults({ configuration: { sessionSampleRate: 0 } })

      expect(expireSessionSpy).not.toHaveBeenCalled()
      expect(renewSessionSpy).not.toHaveBeenCalled()
      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.NOT_TRACKED)
      expect(getSessionState(SESSION_STORE_KEY).id).not.toBeDefined()
      expect(getSessionState(SESSION_STORE_KEY).isExpired).not.toBeDefined()
    })

    it('when tracked should keep existing session type and id', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=1&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)

      startRumSessionManagerWithDefaults()

      expect(expireSessionSpy).not.toHaveBeenCalled()
      expect(renewSessionSpy).not.toHaveBeenCalled()
      expect(getSessionState(SESSION_STORE_KEY).id).toBe('abcdef')
      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
    })

    it('when not tracked should keep existing session type', () => {
      setCookie(SESSION_STORE_KEY, `rum=0&expire=${Date.now() + DURATION}`, DURATION)

      startRumSessionManagerWithDefaults()

      expect(expireSessionSpy).not.toHaveBeenCalled()
      expect(renewSessionSpy).not.toHaveBeenCalled()
      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.NOT_TRACKED)
    })

    it('should renew on activity after expiration', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=1&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)

      startRumSessionManagerWithDefaults({ configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 100 } })

      expireCookie()
      expect(getSessionState(SESSION_STORE_KEY).isExpired).toBe('1')
      expect(expireSessionSpy).not.toHaveBeenCalled()
      expect(renewSessionSpy).not.toHaveBeenCalled()
      clock.tick(STORAGE_POLL_DELAY)

      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(expireSessionSpy).toHaveBeenCalled()
      expect(renewSessionSpy).toHaveBeenCalled()
      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
      expect(getSessionState(SESSION_STORE_KEY).id).toMatch(/[a-f0-9-]/)
    })
  })

  describe('findSession', () => {
    it('should return the current session', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=1&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults()
      expect(rumSessionManager.findTrackedSession()!.id).toBe('abcdef')
    })

    it('should return undefined if the session is not tracked', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=0&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults()
      expect(rumSessionManager.findTrackedSession()).toBe(undefined)
    })

    it('should return undefined if the session has expired', () => {
      const rumSessionManager = startRumSessionManagerWithDefaults()
      expireCookie()
      clock.tick(STORAGE_POLL_DELAY)
      expect(rumSessionManager.findTrackedSession()).toBe(undefined)
    })

    it('should return session corresponding to start time', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=1&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults()
      clock.tick(10 * ONE_SECOND)
      expireCookie()
      clock.tick(STORAGE_POLL_DELAY)
      expect(rumSessionManager.findTrackedSession()).toBeUndefined()
      expect(rumSessionManager.findTrackedSession(0 as RelativeTime)!.id).toBe('abcdef')
    })

    it('should return session TRACKED_WITH_SESSION_REPLAY', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=1&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults()
      expect(rumSessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.SAMPLED)
    })

    it('should return session TRACKED_WITHOUT_SESSION_REPLAY', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=2&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults()
      expect(rumSessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.OFF)
    })

    it('should update current entity when replay recording is forced', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=2&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults()
      rumSessionManager.setForcedReplay()

      expect(rumSessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.FORCED)
    })
  })

  describe('session behaviors', () => {
    ;[
      {
        description: 'TRACKED_WITH_SESSION_REPLAY should have replay',
        sessionReplaySampleRate: 100,
        expectSessionReplay: SessionReplayState.SAMPLED,
      },
      {
        description: 'TRACKED_WITHOUT_SESSION_REPLAY should have no replay',
        sessionReplaySampleRate: 0,
        expectSessionReplay: SessionReplayState.OFF,
      },
    ].forEach(
      ({
        description,
        sessionReplaySampleRate,
        expectSessionReplay,
      }: {
        description: string
        sessionReplaySampleRate: number
        expectSessionReplay: SessionReplayState
      }) => {
        it(description, () => {
          const rumSessionManager = startRumSessionManagerWithDefaults({
            configuration: { sessionSampleRate: 100, sessionReplaySampleRate },
          })
          expect(rumSessionManager.findTrackedSession()!.sessionReplay).toBe(expectSessionReplay)
        })
      }
    )
  })

  // FLASHCAT FORK - sampling rates set in the console.
  describe('remote sampling', () => {
    const STORE_KEY = 'test-remote-sampling'
    const REMOTE_SAMPLING_SETUP = {
      buildUrl: () => 'https://example.com/config',
      storeKey: STORE_KEY,
      fetchTimeout: 3000,
    }

    function storeRemoteConfigValues(values: {
      version?: number
      sessionSampleRate?: number
      sessionReplaySampleRate?: number
      traceSampleRate?: number
      defaultPrivacyLevel?: string
    }) {
      localStorage.setItem(STORE_KEY, JSON.stringify(values))
      registerCleanupTask(() => localStorage.removeItem(STORE_KEY))
    }

    it('draws a new session on the remote rate rather than the one passed to init', () => {
      storeRemoteConfigValues({ sessionSampleRate: 100, sessionReplaySampleRate: 100 })

      startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, remoteConfig: REMOTE_SAMPLING_SETUP },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
    })

    it('draws replay on the remote replay rate', () => {
      storeRemoteConfigValues({ sessionReplaySampleRate: 100 })

      startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 0, remoteConfig: REMOTE_SAMPLING_SETUP },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
    })

    it('falls back to the rate passed to init for a knob the console did not set', () => {
      storeRemoteConfigValues({ sessionReplaySampleRate: 100 })

      startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, remoteConfig: REMOTE_SAMPLING_SETUP },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.NOT_TRACKED)
    })

    it('leaves a session already under way on the decision it was created with', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=1&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      storeRemoteConfigValues({ sessionSampleRate: 0, sessionReplaySampleRate: 0 })

      startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 100, remoteConfig: REMOTE_SAMPLING_SETUP },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(getSessionState(SESSION_STORE_KEY).id).toBe('abcdef')
      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
    })

    it('ignores anything in storage when the site did not opt in', () => {
      storeRemoteConfigValues({ sessionSampleRate: 100, sessionReplaySampleRate: 100 })

      startRumSessionManagerWithDefaults({ configuration: { sessionSampleRate: 0 } })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.NOT_TRACKED)
    })
  })

  describe('beforeSampling', () => {
    const STORE_KEY = 'test-before-sampling'
    const REMOTE_SAMPLING_SETUP = {
      buildUrl: () => 'https://example.com/config',
      storeKey: STORE_KEY,
      fetchTimeout: 3000,
    }

    function storeRemote(stored: object) {
      localStorage.setItem(STORE_KEY, JSON.stringify(stored))
      registerCleanupTask(() => localStorage.removeItem(STORE_KEY))
    }

    it('gets the last word on the rates at the draw', () => {
      startRumSessionManagerWithDefaults({
        configuration: {
          sessionSampleRate: 0,
          sessionReplaySampleRate: 0,
          beforeSampling: () => ({ sessionSampleRate: 100, sessionReplaySampleRate: 100 }),
        },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
    })

    it('receives the delivered rates and custom values', () => {
      storeRemote({ sessionSampleRate: 42, custom: { viplist: ['u-1'] } })
      const beforeSampling = jasmine.createSpy('beforeSampling')

      startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, remoteConfig: REMOTE_SAMPLING_SETUP, beforeSampling },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(beforeSampling).toHaveBeenCalledOnceWith({
        sessionSampleRate: 42,
        sessionReplaySampleRate: 50,
        custom: { viplist: ['u-1'] },
      })
    })

    it('ignores an out-of-range rate', () => {
      startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, beforeSampling: () => ({ sessionSampleRate: 150 }) },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.NOT_TRACKED)
    })

    it('never lets a thrown error reach session creation', () => {
      startRumSessionManagerWithDefaults({
        configuration: {
          sessionSampleRate: 100,
          sessionReplaySampleRate: 100,
          beforeSampling: () => {
            throw new Error('boom')
          },
        },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
    })

    it('is not consulted for a session already under way', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=1&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      const beforeSampling = jasmine.createSpy('beforeSampling')

      startRumSessionManagerWithDefaults({ configuration: { beforeSampling } })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(beforeSampling).not.toHaveBeenCalled()
      expect(getSessionState(SESSION_STORE_KEY).id).toBe('abcdef')
    })
  })

  describe('forced session', () => {
    it('forces the next session to be collected with replay despite a zero rate', () => {
      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, sessionReplaySampleRate: 0 },
      })

      rumSessionManager.setForcedSession()
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
    })

    it('ends a session that was not being collected so a collected one can start', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=0&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, sessionReplaySampleRate: 0 },
      })

      rumSessionManager.setForcedSession()
      expect(getSessionState(SESSION_STORE_KEY).isExpired).toBe('1')

      clock.tick(STORAGE_POLL_DELAY)
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
      expect(getSessionState(SESSION_STORE_KEY).id).not.toBe('abcdef')
    })

    it('keeps a session collected without replay and forces replay onto it', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=2&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults()

      rumSessionManager.setForcedSession()

      const session = rumSessionManager.findTrackedSession()!
      expect(session.id).toBe('abcdef')
      expect(session.sessionReplay).toBe(SessionReplayState.FORCED)
    })

    it('leaves a session already collected with replay untouched', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=1&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults()

      rumSessionManager.setForcedSession()

      const session = rumSessionManager.findTrackedSession()!
      expect(session.id).toBe('abcdef')
      expect(session.sessionReplay).toBe(SessionReplayState.SAMPLED)
      expect(expireSessionSpy).not.toHaveBeenCalled()
    })
  })

  describe('drawn configuration', () => {
    const STORE_KEY = 'test-drawn-configuration'
    const DRAW_KEY = 'test-drawn-configuration-draw'
    const REMOTE_SAMPLING_SETUP = {
      buildUrl: () => 'https://example.com/config',
      storeKey: STORE_KEY,
      fetchTimeout: 3000,
    }

    afterEach(() => localStorage.removeItem(DRAW_KEY))

    function storeRemote(stored: object) {
      localStorage.setItem(STORE_KEY, JSON.stringify(stored))
      registerCleanupTask(() => localStorage.removeItem(STORE_KEY))
    }

    it('leaves the delivered rate in place when it throws, rather than handing the draw back to init', () => {
      // The rates in hand at the moment the callback failed are the console's, and they are what
      // must survive. Written with init and console disagreeing on purpose: with both at 100 a
      // `catch` that reset the rates to the init values would pass too, and that is exactly the
      // regression this is here to catch.
      storeRemote({ version: 2, sessionSampleRate: 100, sessionReplaySampleRate: 100 })

      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: {
          sessionSampleRate: 0,
          sessionReplaySampleRate: 0,
          remoteConfig: REMOTE_SAMPLING_SETUP,
          drawStoreKey: DRAW_KEY,
          beforeSampling: () => {
            throw new Error('boom')
          },
        },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
      expect(rumSessionManager.findTrackedSession()!.drawnConfiguration).toEqual({
        version: 2,
        sessionSampleRate: 100,
        sessionReplaySampleRate: 100,
        traceSampleRate: undefined,
        defaultPrivacyLevel: 'mask',
      })
    })

    it('exposes the rates and version the session was drawn under', () => {
      storeRemote({ version: 12, sessionSampleRate: 100, sessionReplaySampleRate: 100 })

      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, remoteConfig: REMOTE_SAMPLING_SETUP, drawStoreKey: DRAW_KEY },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(rumSessionManager.findTrackedSession()!.drawnConfiguration).toEqual({
        version: 12,
        sessionSampleRate: 100,
        sessionReplaySampleRate: 100,
        // No rule set a trace rate: this configuration passed none to init and the console
        // delivered none. That is not the same as a rule of 100, and the draw has to keep the
        // difference — see `rule_psr` in resourceCollection.
        traceSampleRate: undefined,
        defaultPrivacyLevel: 'mask',
      })
    })

    it('reports the rate beforeSampling decided, not the delivered one', () => {
      storeRemote({ version: 3, sessionSampleRate: 0, sessionReplaySampleRate: 0 })

      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: {
          sessionSampleRate: 0,
          remoteConfig: REMOTE_SAMPLING_SETUP,
          drawStoreKey: DRAW_KEY,
          beforeSampling: () => ({ sessionSampleRate: 100, sessionReplaySampleRate: 100 }),
        },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(rumSessionManager.findTrackedSession()!.drawnConfiguration).toEqual({
        version: 3,
        sessionSampleRate: 100,
        sessionReplaySampleRate: 100,
        traceSampleRate: undefined,
        defaultPrivacyLevel: 'mask',
      })
    })

    it('records a forced session as drawn at 100', () => {
      storeRemote({ version: 5, sessionSampleRate: 0, sessionReplaySampleRate: 0 })

      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, remoteConfig: REMOTE_SAMPLING_SETUP, drawStoreKey: DRAW_KEY },
      })
      rumSessionManager.setForcedSession()
      clock.tick(STORAGE_POLL_DELAY)
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(rumSessionManager.findTrackedSession()!.drawnConfiguration).toEqual({
        version: 5,
        sessionSampleRate: 100,
        sessionReplaySampleRate: 100,
        traceSampleRate: undefined,
        defaultPrivacyLevel: 'mask',
      })
    })

    it('survives a page reload through storage', () => {
      storeRemote({ version: 7, sessionSampleRate: 100, sessionReplaySampleRate: 100 })

      startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, remoteConfig: REMOTE_SAMPLING_SETUP, drawStoreKey: DRAW_KEY },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))
      stopSessionManager()

      const restartedManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, remoteConfig: REMOTE_SAMPLING_SETUP, drawStoreKey: DRAW_KEY },
      })

      expect(restartedManager.findTrackedSession()!.drawnConfiguration).toEqual({
        version: 7,
        sessionSampleRate: 100,
        sessionReplaySampleRate: 100,
        traceSampleRate: undefined,
        defaultPrivacyLevel: 'mask',
      })
    })

    it('refuses a stored record whose rates are not rates', () => {
      // The record is read back on every event assembled for the session, so one holding a string
      // where a number belongs would carry that string into the arithmetic. Anything in a browser
      // profile can be edited by hand, so it is checked on the way out as well as on the way in.
      // Refused, it reads exactly like a site that never wrote one: the session carries no drawn
      // configuration and events fall back to the settings init was given.
      storeRemote({ version: 7, sessionSampleRate: 100, sessionReplaySampleRate: 100 })

      startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, remoteConfig: REMOTE_SAMPLING_SETUP, drawStoreKey: DRAW_KEY },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))
      stopSessionManager()

      const tampered = JSON.parse(localStorage.getItem(DRAW_KEY)!) as Record<string, unknown>
      localStorage.setItem(DRAW_KEY, JSON.stringify({ ...tampered, sessionSampleRate: 'all of them' }))

      const restartedManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, remoteConfig: REMOTE_SAMPLING_SETUP, drawStoreKey: DRAW_KEY },
      })

      // The sibling test above shows the same flow without tampering restores the record, so this
      // is evidence of a refusal rather than of the record never having been written.
      expect(restartedManager.findTrackedSession()!.drawnConfiguration).toBeUndefined()
    })

    it('latches the delivered trace rate and privacy level, not just the sampling rates', () => {
      storeRemote({
        version: 21,
        sessionSampleRate: 100,
        sessionReplaySampleRate: 100,
        traceSampleRate: 10,
        defaultPrivacyLevel: 'allow',
      })

      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: {
          sessionSampleRate: 0,
          traceSampleRate: 100,
          defaultPrivacyLevel: 'mask',
          remoteConfig: REMOTE_SAMPLING_SETUP,
          drawStoreKey: DRAW_KEY,
        },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(rumSessionManager.findTrackedSession()!.drawnConfiguration).toEqual({
        version: 21,
        sessionSampleRate: 100,
        sessionReplaySampleRate: 100,
        traceSampleRate: 10,
        defaultPrivacyLevel: 'allow',
      })
    })

    it('keeps the drawn trace rate and privacy level when a later delivery changes them', () => {
      storeRemote({ version: 1, sessionSampleRate: 100, sessionReplaySampleRate: 100, traceSampleRate: 10 })

      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: {
          sessionSampleRate: 0,
          traceSampleRate: 100,
          defaultPrivacyLevel: 'mask',
          remoteConfig: REMOTE_SAMPLING_SETUP,
          drawStoreKey: DRAW_KEY,
        },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      // A new configuration lands while the session is still running.
      storeRemote({
        version: 2,
        sessionSampleRate: 100,
        sessionReplaySampleRate: 100,
        traceSampleRate: 90,
        defaultPrivacyLevel: 'allow',
      })

      const drawn = rumSessionManager.findTrackedSession()!.drawnConfiguration!
      expect(drawn.traceSampleRate).toBe(10)
      expect(drawn.defaultPrivacyLevel).toBe('mask')
      expect(drawn.version).toBe(1)
    })

    it('falls back to init for a record written before these two were stored', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=1&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      localStorage.setItem(
        DRAW_KEY,
        JSON.stringify({ id: 'abcdef', version: 4, sessionSampleRate: 100, sessionReplaySampleRate: 100 })
      )

      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: {
          traceSampleRate: 42,
          rulePsr: 0.42,
          defaultPrivacyLevel: 'mask-user-input',
          remoteConfig: REMOTE_SAMPLING_SETUP,
          drawStoreKey: DRAW_KEY,
        },
      })

      const drawn = rumSessionManager.findTrackedSession()!.drawnConfiguration!
      expect(drawn.traceSampleRate).toBe(42)
      expect(drawn.defaultPrivacyLevel).toBe('mask-user-input')
    })

    it('refuses a stored privacy level on a site that never opted into remote configuration', () => {
      // Only remote configuration can move the privacy level: `beforeSampling` and
      // `setForcedSession()` shape the rates and reach neither it nor the trace rate. So on a site
      // that did not opt in, a record carrying `allow` is not one this SDK wrote — and honouring it
      // would let any same-origin script take a site that asked for `mask` into an unmasked replay
      // with a single storage write.
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=1&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      localStorage.setItem(
        DRAW_KEY,
        JSON.stringify({
          id: 'abcdef',
          sessionSampleRate: 100,
          sessionReplaySampleRate: 100,
          traceSampleRate: 3,
          defaultPrivacyLevel: 'allow',
        })
      )

      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: { defaultPrivacyLevel: 'mask', drawStoreKey: DRAW_KEY },
      })

      const drawn = rumSessionManager.findTrackedSession()!.drawnConfiguration!
      expect(drawn.defaultPrivacyLevel).toBe('mask')
      expect(drawn.traceSampleRate).toBeUndefined()
      // The rates are still read back: those two APIs really can move them with the feature off.
      expect(drawn.sessionSampleRate).toBe(100)
    })

    it('forgets the record when the visitor withdraws consent', () => {
      // Withdrawing consent is the one moment the SDK promises the session id stops existing — the
      // session store is rewritten without it. Storage does not expire on its own, so the copy kept
      // here has to go with it, or it outlives the withdrawal for a consent audit to find.
      const trackingConsentState = createTrackingConsentState(TrackingConsent.GRANTED)
      storeRemote({ version: 4, sessionSampleRate: 100, sessionReplaySampleRate: 100 })
      startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, remoteConfig: REMOTE_SAMPLING_SETUP, drawStoreKey: DRAW_KEY },
        trackingConsentState,
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))
      expect(localStorage.getItem(DRAW_KEY)).not.toBeNull()

      trackingConsentState.update(TrackingConsent.NOT_GRANTED)

      expect(localStorage.getItem(DRAW_KEY)).toBeNull()
    })

    it('keeps the record when a session merely expires', () => {
      // The negative control on the line above. Sessions expire and renew constantly, and the tab
      // that notices an expiry is not always the tab that drew what replaced it — removing the
      // record there would let a page still polling delete what another page had just written for
      // the new session, putting every tab back on its own settings.
      storeRemote({ version: 4, sessionSampleRate: 100, sessionReplaySampleRate: 100 })
      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, remoteConfig: REMOTE_SAMPLING_SETUP, drawStoreKey: DRAW_KEY },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))
      expect(localStorage.getItem(DRAW_KEY)).not.toBeNull()

      rumSessionManager.expire()

      expect(localStorage.getItem(DRAW_KEY)).not.toBeNull()
    })

    it('never matches a session the record was not written for', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=1&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      localStorage.setItem(
        DRAW_KEY,
        JSON.stringify({ id: 'other-session', version: 9, sessionSampleRate: 100, sessionReplaySampleRate: 100 })
      )

      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: { remoteConfig: REMOTE_SAMPLING_SETUP, drawStoreKey: DRAW_KEY },
      })

      expect(rumSessionManager.findTrackedSession()!.drawnConfiguration).toBeUndefined()
    })

    it('is absent when the draw landed on exactly what init passed', () => {
      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 100, drawStoreKey: DRAW_KEY },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(rumSessionManager.findTrackedSession()!.drawnConfiguration).toBeUndefined()
      expect(localStorage.getItem(DRAW_KEY)).toBeNull()
    })

    it('records a draw beforeSampling moved, with remote configuration off', () => {
      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: {
          sessionSampleRate: 0,
          sessionReplaySampleRate: 0,
          drawStoreKey: DRAW_KEY,
          beforeSampling: () => ({ sessionSampleRate: 100, sessionReplaySampleRate: 100 }),
        },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(rumSessionManager.findTrackedSession()!.drawnConfiguration).toEqual({
        version: undefined,
        sessionSampleRate: 100,
        sessionReplaySampleRate: 100,
        traceSampleRate: undefined,
        defaultPrivacyLevel: 'mask',
      })
    })

    it('adopts the record another tab wrote for the session it renewed onto', () => {
      setCookie(SESSION_STORE_KEY, `id=abcdef&rum=1&created=${Date.now()}&expire=${Date.now() + DURATION}`, DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: { remoteConfig: REMOTE_SAMPLING_SETUP, drawStoreKey: DRAW_KEY },
      })

      // Another tab draws the next session and records it. Nothing is drawn on this page, so
      // reading that record back is the only way it can report and trace the session it now shares
      // the way the tab that drew it does.
      setCookie(
        SESSION_STORE_KEY,
        `id=drawn-elsewhere&rum=1&created=${Date.now()}&expire=${Date.now() + DURATION}`,
        DURATION
      )
      localStorage.setItem(
        DRAW_KEY,
        JSON.stringify({
          id: 'drawn-elsewhere',
          version: 8,
          sessionSampleRate: 20,
          sessionReplaySampleRate: 20,
          traceSampleRate: 30,
          defaultPrivacyLevel: 'allow',
        })
      )
      clock.tick(STORAGE_POLL_DELAY)
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      const session = rumSessionManager.findTrackedSession()!
      expect(session.id).toBe('drawn-elsewhere')
      expect(session.drawnConfiguration).toEqual({
        version: 8,
        sessionSampleRate: 20,
        sessionReplaySampleRate: 20,
        traceSampleRate: 30,
        defaultPrivacyLevel: 'allow',
      })
    })

    it('answers for the session an event belongs to, not the one that is current', () => {
      storeRemote({ version: 1, sessionSampleRate: 100, sessionReplaySampleRate: 100, traceSampleRate: 10 })
      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 0, remoteConfig: REMOTE_SAMPLING_SETUP, drawStoreKey: DRAW_KEY },
      })
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))
      const duringFirstSession = relativeNow()

      // The console changes the trace rate; the session it applies to is the next one.
      storeRemote({ version: 2, sessionSampleRate: 100, sessionReplaySampleRate: 100, traceSampleRate: 90 })
      expireCookie()
      clock.tick(STORAGE_POLL_DELAY)
      document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

      expect(rumSessionManager.findTrackedSession()!.drawnConfiguration!.traceSampleRate).toBe(90)
      expect(rumSessionManager.findTrackedSession(duringFirstSession)!.drawnConfiguration!.traceSampleRate).toBe(10)
    })
  })

  describe('restarting the session when the settings are decisive', () => {
    const STORE_KEY = 'test-decisive-settings'
    const DRAW_KEY = 'test-decisive-settings-draw'
    const REMOTE_SETUP = {
      buildUrl: () => 'https://example.com/config',
      storeKey: STORE_KEY,
      fetchTimeout: 3000,
    }

    afterEach(() => localStorage.removeItem(DRAW_KEY))

    function storeRemote(stored: object) {
      localStorage.setItem(STORE_KEY, JSON.stringify(stored))
      registerCleanupTask(() => localStorage.removeItem(STORE_KEY))
    }

    function startWith(configuration: Partial<RumConfiguration> = {}) {
      return startRumSessionManagerWithDefaults({
        configuration: { remoteConfig: REMOTE_SETUP, drawStoreKey: DRAW_KEY, ...configuration },
      })
    }

    // Settings reach storage first and are announced afterwards, the order the fetcher uses: the
    // draw that may follow reads storage, so it has to find them already there.
    function deliver(stored: object) {
      storeRemote(stored)
      lifeCycle.notify(LifeCycleEventType.REMOTE_CONFIGURATION_STORED)
    }

    function isSessionEnded() {
      return getSessionState(SESSION_STORE_KEY).isExpired === '1'
    }

    describe('the three changes it can decide on its own', () => {
      it('ends a session being collected when the rate goes to zero', () => {
        storeRemote({ version: 1, sessionSampleRate: 100, sessionReplaySampleRate: 100 })
        startWith({ sessionSampleRate: 100 })
        expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)

        deliver({ version: 2, sessionSampleRate: 0, sessionReplaySampleRate: 0 })

        expect(isSessionEnded()).toBeTrue()
      })

      it('ends a session that is not being collected when the rate goes to a hundred', () => {
        storeRemote({ version: 1, sessionSampleRate: 0 })
        startWith({ sessionSampleRate: 0 })
        expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.NOT_TRACKED)

        deliver({ version: 2, sessionSampleRate: 100, sessionReplaySampleRate: 100 })

        expect(isSessionEnded()).toBeTrue()
      })

      it('ends the session when the privacy level tightens', () => {
        storeRemote({ version: 1, sessionSampleRate: 100, defaultPrivacyLevel: 'allow' })
        startWith({ sessionSampleRate: 100, defaultPrivacyLevel: 'allow' })

        deliver({ version: 2, sessionSampleRate: 100, defaultPrivacyLevel: 'mask-user-input' })

        expect(isSessionEnded()).toBeTrue()
      })

      it('ends the session on the tightening step that masks everything', () => {
        storeRemote({ version: 1, sessionSampleRate: 100, defaultPrivacyLevel: 'mask-user-input' })
        startWith({ sessionSampleRate: 100, defaultPrivacyLevel: 'allow' })

        deliver({ version: 2, sessionSampleRate: 100, defaultPrivacyLevel: 'mask' })

        expect(isSessionEnded()).toBeTrue()
      })

      it('draws the session that follows on the settings that have just landed', () => {
        storeRemote({ version: 1, sessionSampleRate: 0 })
        startWith({ sessionSampleRate: 0 })

        deliver({ version: 2, sessionSampleRate: 100, sessionReplaySampleRate: 100 })
        clock.tick(STORAGE_POLL_DELAY)
        document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))

        expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
      })
    })

    describe('everything else waits for the next session', () => {
      it('leaves the session alone when the rate moves to a value it cannot decide on', () => {
        storeRemote({ version: 1, sessionSampleRate: 100 })
        startWith({ sessionSampleRate: 100 })

        deliver({ version: 2, sessionSampleRate: 30 })

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })

      it('leaves a session that is not collected alone when the rate merely rises', () => {
        storeRemote({ version: 1, sessionSampleRate: 0 })
        startWith({ sessionSampleRate: 0 })

        deliver({ version: 2, sessionSampleRate: 30 })

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })

      it('leaves a session that is not being collected alone when the privacy level tightens', () => {
        storeRemote({ version: 1, sessionSampleRate: 0, defaultPrivacyLevel: 'allow' })
        startWith({ sessionSampleRate: 0, defaultPrivacyLevel: 'allow' })
        expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.NOT_TRACKED)

        // Nothing is being recorded for this visitor, so there is no plaintext for the stricter
        // level to catch and nothing to gain by ending their session.
        deliver({ version: 2, sessionSampleRate: 0, defaultPrivacyLevel: 'mask' })

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })

      it('does not end one sampled-out session after another as settings keep arriving', () => {
        // A session that is not collected is given no id, so no record of its draw is kept and the
        // level it was drawn under cannot be read back. Ending it would not change that, so acting
        // on the comparison would end every session this visitor is ever given.
        storeRemote({ version: 1, sessionSampleRate: 0, defaultPrivacyLevel: 'allow' })
        startWith({ sessionSampleRate: 0, defaultPrivacyLevel: 'allow' })

        deliver({ version: 2, sessionSampleRate: 0, defaultPrivacyLevel: 'mask' })
        clock.tick(STORAGE_POLL_DELAY)
        document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))
        deliver({ version: 3, sessionSampleRate: 0, defaultPrivacyLevel: 'mask' })

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })

      it('leaves the session alone when the privacy level loosens', () => {
        storeRemote({ version: 1, sessionSampleRate: 100, defaultPrivacyLevel: 'mask' })
        startWith({ sessionSampleRate: 100 })

        // Being slow here is the point: it leaves an operator time to undo a mistake, and what it
        // costs meanwhile is more of the data already being collected.
        deliver({ version: 2, sessionSampleRate: 100, defaultPrivacyLevel: 'allow' })

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })

      it('leaves the session alone when only the custom bag changed', () => {
        storeRemote({ version: 1, sessionSampleRate: 100, custom: { cohort: 'a' } })
        startWith({ sessionSampleRate: 100 })

        deliver({ version: 2, sessionSampleRate: 100, custom: { cohort: 'b' } })

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })

      it('leaves the session alone when only the trace rate changed', () => {
        storeRemote({ version: 1, sessionSampleRate: 100, traceSampleRate: 10 })
        startWith({ sessionSampleRate: 100 })

        deliver({ version: 2, sessionSampleRate: 100, traceSampleRate: 90 })

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })

      it('leaves the session alone when only the replay rate changed', () => {
        storeRemote({ version: 1, sessionSampleRate: 100, sessionReplaySampleRate: 100 })
        startWith({ sessionSampleRate: 100 })

        // The replay rate is deliberately not one of the three: it decides a draw nested inside the
        // session draw, and a rule for it would have to say what happens to a replay the host
        // application forced on. Until that is settled, a replay rate change waits for the next
        // session like every other change.
        deliver({ version: 2, sessionSampleRate: 100, sessionReplaySampleRate: 0 })

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })

      it('reads nothing out of the settings store when the site did not opt in', () => {
        storeRemote({ version: 1, sessionSampleRate: 100 })
        startRumSessionManagerWithDefaults({ configuration: { sessionSampleRate: 0, drawStoreKey: DRAW_KEY } })

        // Such a site never fetches, so this can only ever be reached by hand. What matters is that
        // the settings store is out of reach without the opt-in: the rate that would apply is the
        // one init passed, which is the one this session was already drawn on.
        deliver({ version: 2, sessionSampleRate: 100 })

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })

      it('has nothing to end when the session is already over', () => {
        storeRemote({ version: 1, sessionSampleRate: 0 })
        startWith({ sessionSampleRate: 0 })
        expireCookie()
        clock.tick(STORAGE_POLL_DELAY)
        expireSessionSpy.calls.reset()

        // There is no session to read a decision off, and nothing to end: the next activity draws
        // on what has just been stored, which is all this change needs.
        expect(() => deliver({ version: 2, sessionSampleRate: 100 })).not.toThrow()
        expect(expireSessionSpy).not.toHaveBeenCalled()
      })
    })

    describe('what it compares', () => {
      it('never draws again to reach its decision', () => {
        storeRemote({ version: 1, sessionSampleRate: 100 })
        startWith({ sessionSampleRate: 100 })
        const draw = spyOn(Math, 'random').and.callThrough()

        deliver({ version: 2, sessionSampleRate: 30 })

        // Drawing here would be a second lottery on top of the one the next session runs, quietly
        // turning a rate p into p².
        expect(draw).not.toHaveBeenCalled()
      })

      it('compares against the level the session was drawn under, not the settings stored since', () => {
        storeRemote({ version: 1, sessionSampleRate: 100, defaultPrivacyLevel: 'mask' })
        startWith({ sessionSampleRate: 100, defaultPrivacyLevel: 'allow' })

        // A loosening leaves the running session masking everything, as it was drawn to.
        deliver({ version: 2, sessionSampleRate: 100, defaultPrivacyLevel: 'allow' })
        expect(expireSessionSpy).not.toHaveBeenCalled()

        // Stricter than what was stored a moment ago, still looser than what this session actually
        // masks with. Judged against the stored settings it would end a session with nothing to
        // gain from restarting.
        deliver({ version: 3, sessionSampleRate: 100, defaultPrivacyLevel: 'mask-user-input' })

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })

      it('lets beforeSampling have the last word on the rate it judges', () => {
        storeRemote({ version: 1, sessionSampleRate: 100 })
        startWith({
          sessionSampleRate: 100,
          beforeSampling: ({ sessionSampleRate }) => ({ sessionSampleRate: sessionSampleRate === 0 ? 50 : 100 }),
        })

        // The console says zero, the application puts it back in the middle: the rate that would
        // actually apply is fifty, which decides nothing.
        deliver({ version: 2, sessionSampleRate: 0 })

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })
    })

    describe('arriving more than once', () => {
      it('does not end the session a second time when the same settings arrive again', () => {
        storeRemote({ version: 1, sessionSampleRate: 100, sessionReplaySampleRate: 100 })
        startWith({ sessionSampleRate: 100 })

        deliver({ version: 2, sessionSampleRate: 0 })
        expect(isSessionEnded()).toBeTrue()

        clock.tick(STORAGE_POLL_DELAY)
        document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))
        expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.NOT_TRACKED)
        expireSessionSpy.calls.reset()

        // Another tab, a retry, a reload: the same answer arrives again and finds the difference
        // that justified ending a session already gone.
        lifeCycle.notify(LifeCycleEventType.REMOTE_CONFIGURATION_STORED)
        lifeCycle.notify(LifeCycleEventType.REMOTE_CONFIGURATION_STORED)

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })

      it('stops tightening the privacy level once the session is drawn under it', () => {
        storeRemote({ version: 1, sessionSampleRate: 100, defaultPrivacyLevel: 'allow' })
        startWith({ sessionSampleRate: 100, defaultPrivacyLevel: 'allow' })

        deliver({ version: 2, sessionSampleRate: 100, defaultPrivacyLevel: 'mask' })
        expect(isSessionEnded()).toBeTrue()

        clock.tick(STORAGE_POLL_DELAY)
        document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))
        expireSessionSpy.calls.reset()

        lifeCycle.notify(LifeCycleEventType.REMOTE_CONFIGURATION_STORED)

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })
    })

    describe('a session the host application forced', () => {
      function startForced(configuration: Partial<RumConfiguration> = {}) {
        const rumSessionManager = startWith({ sessionSampleRate: 0, ...configuration })
        rumSessionManager.setForcedSession()
        clock.tick(STORAGE_POLL_DELAY)
        document.dispatchEvent(createNewEvent(DOM_EVENT.CLICK))
        expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
        expireSessionSpy.calls.reset()
        return rumSessionManager
      }

      it('is not ended by a rate, since every draw it makes is collected anyway', () => {
        storeRemote({ version: 1, sessionSampleRate: 0 })
        startForced()

        // Ending it would only replace it with another forced session — the same difference, for
        // as long as the page lives.
        deliver({ version: 2, sessionSampleRate: 0 })

        expect(expireSessionSpy).not.toHaveBeenCalled()
        expect(isSessionEnded()).toBeFalse()
      })

      it('is still ended when the privacy level tightens', () => {
        storeRemote({ version: 1, sessionSampleRate: 0, defaultPrivacyLevel: 'allow' })
        startForced({ defaultPrivacyLevel: 'allow' })

        // Forcing decides whether this visitor is collected. It says nothing about how much of
        // their page may be uploaded in the clear.
        deliver({ version: 2, sessionSampleRate: 0, defaultPrivacyLevel: 'mask' })

        expect(isSessionEnded()).toBeTrue()
      })
    })
  })

  function startRumSessionManagerWithDefaults({
    configuration,
    trackingConsentState = createTrackingConsentState(TrackingConsent.GRANTED),
  }: { configuration?: Partial<RumConfiguration>; trackingConsentState?: TrackingConsentState } = {}) {
    const sessionManager = startRumSessionManager(
      mockRumConfiguration({
        sessionSampleRate: 50,
        sessionReplaySampleRate: 50,
        trackResources: true,
        trackLongTasks: true,
        ...configuration,
      }),
      lifeCycle,
      trackingConsentState
    )
    registerCleanupTask(sessionManager.stop)
    return sessionManager
  }
})

describe('rum session manager stub', () => {
  let lifeCycle: LifeCycle

  beforeEach(() => {
    lifeCycle = new LifeCycle()
  })

  function startStub(configuration: RumConfiguration = mockRumConfiguration()) {
    const sessionManager = startRumSessionManagerStub(configuration, lifeCycle)
    registerCleanupTask(sessionManager.stop)
    return sessionManager
  }

  it('should return a tracked session with replay allowed when the event bridge support records', () => {
    mockEventBridge({ capabilities: [BridgeCapability.RECORDS] })
    expect(startStub().findTrackedSession()!.sessionReplay).toEqual(SessionReplayState.SAMPLED)
  })

  it('should return a tracked session without replay allowed when the event bridge support records', () => {
    mockEventBridge({ capabilities: [] })
    expect(startStub().findTrackedSession()!.sessionReplay).toEqual(SessionReplayState.OFF)
  })

  // FLASHCAT FORK - see `sessionReplayDirectUpload` in RumInitConfiguration.
  describe('with sessionReplayDirectUpload', () => {
    it('should return a tracked session with replay allowed even when the bridge does not support records', () => {
      mockEventBridge({ capabilities: [] })
      const configuration = mockRumConfiguration({ sessionReplayDirectUpload: true, sessionReplaySampleRate: 100 })
      expect(startStub(configuration).findTrackedSession()!.sessionReplay).toEqual(SessionReplayState.SAMPLED)
    })

    it('should honor sessionReplaySampleRate', () => {
      mockEventBridge({ capabilities: [] })
      const configuration = mockRumConfiguration({ sessionReplayDirectUpload: true, sessionReplaySampleRate: 0 })
      expect(startStub(configuration).findTrackedSession()!.sessionReplay).toEqual(SessionReplayState.OFF)
    })
  })

  // FLASHCAT FORK - the host application owns the session id and the anonymous id.
  describe('host provided identifiers', () => {
    it('should use the session id and the anonymous id provided by the bridge', () => {
      mockEventBridge({ sessionId: 'host-session-id', anonymousId: 'host-anonymous-id' })
      const session = startStub().findTrackedSession()!
      expect(session.id).toBe('host-session-id')
      expect(session.anonymousId).toBe('host-anonymous-id')
    })

    it('should fall back to the placeholder session id when the bridge does not implement the methods', () => {
      mockEventBridge()
      const session = startStub().findTrackedSession()!
      expect(session.id).toBe(STUB_SESSION_ID)
      expect(session.anonymousId).toBeUndefined()
    })

    it('should read the session id again on each call, as the host renews it', () => {
      let sessionId = 'first-session-id'
      const eventBridge = mockEventBridge({ sessionId: '' })
      eventBridge.getSessionId = () => sessionId

      const sessionManager = startStub()
      expect(sessionManager.findTrackedSession()!.id).toBe('first-session-id')

      sessionId = 'renewed-session-id'
      expect(sessionManager.findTrackedSession()!.id).toBe('renewed-session-id')
    })
  })

  // FLASHCAT FORK - a host that answers for the session id and reports none has no session at all
  // right now. Falling back to the placeholder here would attribute this page's Session Replay
  // segments — which it uploads itself, bypassing the host — to a fake session shared by every
  // application, and reusing the previous id would attribute them to a session that has ended.
  describe('when the host reports no session', () => {
    it('should report no tracked session', () => {
      mockEventBridge({ sessionId: '', anonymousId: '' })

      expect(startStub().findTrackedSession()).toBeUndefined()
    })

    it('should not fall back to the placeholder session id', () => {
      mockEventBridge({ sessionId: '' })

      expect(startStub().findTrackedSession()?.id).not.toBe(STUB_SESSION_ID)
    })

    it('should report a tracked session again once the host renews it', () => {
      let sessionId = ''
      const eventBridge = mockEventBridge({ sessionId: '' })
      eventBridge.getSessionId = () => sessionId
      const sessionManager = startStub()

      expect(sessionManager.findTrackedSession()).toBeUndefined()

      sessionId = 'renewed-session-id'
      expect(sessionManager.findTrackedSession()!.id).toBe('renewed-session-id')
    })
  })

  // FLASHCAT FORK - the bridge is pull-only, so the stub polls it the way the regular session
  // manager polls its own store, and turns what it sees into the same lifecycle events. Without
  // them the recorder would keep a segment open across the end of the host session.
  describe('watching the host session', () => {
    let clock: Clock
    let expireSessionSpy: jasmine.Spy
    let renewSessionSpy: jasmine.Spy
    let hostSessionId: string

    beforeEach(() => {
      clock = mockClock()
      registerCleanupTask(clock.cleanup)
      expireSessionSpy = jasmine.createSpy('expireSessionSpy')
      renewSessionSpy = jasmine.createSpy('renewSessionSpy')
      lifeCycle.subscribe(LifeCycleEventType.SESSION_EXPIRED, expireSessionSpy)
      lifeCycle.subscribe(LifeCycleEventType.SESSION_RENEWED, renewSessionSpy)
    })

    function mockHostSession(initialSessionId: string) {
      hostSessionId = initialSessionId
      const eventBridge = mockEventBridge({ sessionId: initialSessionId })
      eventBridge.getSessionId = () => hostSessionId
    }

    it('should notify SESSION_EXPIRED when the host session expires', () => {
      mockHostSession('host-session-id')
      startStub()

      hostSessionId = ''
      clock.tick(STORAGE_POLL_DELAY)

      expect(expireSessionSpy).toHaveBeenCalledTimes(1)
      expect(renewSessionSpy).not.toHaveBeenCalled()
    })

    it('should notify SESSION_RENEWED when the host starts a new session', () => {
      mockHostSession('')
      startStub()

      hostSessionId = 'renewed-session-id'
      clock.tick(STORAGE_POLL_DELAY)

      expect(renewSessionSpy).toHaveBeenCalledTimes(1)
      expect(expireSessionSpy).not.toHaveBeenCalled()
    })

    it('should notify both when the host swaps one session for another without reporting a gap', () => {
      mockHostSession('first-session-id')
      startStub()

      hostSessionId = 'second-session-id'
      clock.tick(STORAGE_POLL_DELAY)

      expect(expireSessionSpy).toHaveBeenCalledTimes(1)
      expect(renewSessionSpy).toHaveBeenCalledTimes(1)
    })

    it('should already answer with the new session when it notifies', () => {
      mockHostSession('first-session-id')
      const sessionManager = startStub()
      const idsSeenBySubscribers: Array<string | undefined> = []
      lifeCycle.subscribe(LifeCycleEventType.SESSION_EXPIRED, () => {
        idsSeenBySubscribers.push(sessionManager.findTrackedSession()?.id)
      })
      lifeCycle.subscribe(LifeCycleEventType.SESSION_RENEWED, () => {
        idsSeenBySubscribers.push(sessionManager.findTrackedSession()?.id)
      })

      hostSessionId = 'second-session-id'
      clock.tick(STORAGE_POLL_DELAY)

      expect(idsSeenBySubscribers).toEqual(['second-session-id', 'second-session-id'])
    })

    it('should not notify anything while the host session does not change', () => {
      mockHostSession('host-session-id')
      startStub()

      clock.tick(10 * STORAGE_POLL_DELAY)

      expect(expireSessionSpy).not.toHaveBeenCalled()
      expect(renewSessionSpy).not.toHaveBeenCalled()
    })

    it('should not watch a host that does not answer for the session id', () => {
      mockEventBridge()
      startStub()

      clock.tick(10 * STORAGE_POLL_DELAY)

      expect(expireSessionSpy).not.toHaveBeenCalled()
      expect(renewSessionSpy).not.toHaveBeenCalled()
    })

    it('should stop watching once stopped', () => {
      mockHostSession('host-session-id')
      startRumSessionManagerStub(mockRumConfiguration(), lifeCycle).stop()

      hostSessionId = ''
      clock.tick(10 * STORAGE_POLL_DELAY)

      expect(expireSessionSpy).not.toHaveBeenCalled()
    })
  })
})
