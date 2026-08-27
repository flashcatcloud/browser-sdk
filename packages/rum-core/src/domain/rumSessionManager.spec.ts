import type { RelativeTime } from '@flashcatcloud/browser-core'
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
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=1', DURATION)

      startRumSessionManagerWithDefaults()

      expect(expireSessionSpy).not.toHaveBeenCalled()
      expect(renewSessionSpy).not.toHaveBeenCalled()
      expect(getSessionState(SESSION_STORE_KEY).id).toBe('abcdef')
      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
    })

    it('when not tracked should keep existing session type', () => {
      setCookie(SESSION_STORE_KEY, 'rum=0', DURATION)

      startRumSessionManagerWithDefaults()

      expect(expireSessionSpy).not.toHaveBeenCalled()
      expect(renewSessionSpy).not.toHaveBeenCalled()
      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.NOT_TRACKED)
    })

    it('should renew on activity after expiration', () => {
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=1', DURATION)

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
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=1', DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults()
      expect(rumSessionManager.findTrackedSession()!.id).toBe('abcdef')
    })

    it('should return undefined if the session is not tracked', () => {
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=0', DURATION)
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
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=1', DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults()
      clock.tick(10 * ONE_SECOND)
      expireCookie()
      clock.tick(STORAGE_POLL_DELAY)
      expect(rumSessionManager.findTrackedSession()).toBeUndefined()
      expect(rumSessionManager.findTrackedSession(0 as RelativeTime)!.id).toBe('abcdef')
    })

    it('should return session TRACKED_WITH_SESSION_REPLAY', () => {
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=1', DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults()
      expect(rumSessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.SAMPLED)
    })

    it('should return session TRACKED_WITHOUT_SESSION_REPLAY', () => {
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=2', DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults()
      expect(rumSessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.OFF)
    })

    it('should update current entity when replay recording is forced', () => {
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=2', DURATION)
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
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=1', DURATION)
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
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=1', DURATION)
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
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=0', DURATION)
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
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=2', DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults()

      rumSessionManager.setForcedSession()

      const session = rumSessionManager.findTrackedSession()!
      expect(session.id).toBe('abcdef')
      expect(session.sessionReplay).toBe(SessionReplayState.FORCED)
    })

    it('leaves a session already collected with replay untouched', () => {
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=1', DURATION)
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
        traceSampleRate: 100,
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
        traceSampleRate: 100,
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
        traceSampleRate: 100,
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
        traceSampleRate: 100,
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
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=1', DURATION)
      localStorage.setItem(
        DRAW_KEY,
        JSON.stringify({ id: 'abcdef', version: 4, sessionSampleRate: 100, sessionReplaySampleRate: 100 })
      )

      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: {
          traceSampleRate: 42,
          defaultPrivacyLevel: 'mask-user-input',
          remoteConfig: REMOTE_SAMPLING_SETUP,
          drawStoreKey: DRAW_KEY,
        },
      })

      const drawn = rumSessionManager.findTrackedSession()!.drawnConfiguration!
      expect(drawn.traceSampleRate).toBe(42)
      expect(drawn.defaultPrivacyLevel).toBe('mask-user-input')
    })

    it('never matches a session the record was not written for', () => {
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=1', DURATION)
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
        traceSampleRate: 100,
        defaultPrivacyLevel: 'mask',
      })
    })

    it('adopts the record another tab wrote for the session it renewed onto', () => {
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=1', DURATION)
      const rumSessionManager = startRumSessionManagerWithDefaults({
        configuration: { remoteConfig: REMOTE_SAMPLING_SETUP, drawStoreKey: DRAW_KEY },
      })

      // Another tab draws the next session and records it. Nothing is drawn on this page, so
      // reading that record back is the only way it can report and trace the session it now shares
      // the way the tab that drew it does.
      setCookie(SESSION_STORE_KEY, 'id=drawn-elsewhere&rum=1', DURATION)
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

  function startRumSessionManagerWithDefaults({ configuration }: { configuration?: Partial<RumConfiguration> } = {}) {
    const sessionManager = startRumSessionManager(
      mockRumConfiguration({
        sessionSampleRate: 50,
        sessionReplaySampleRate: 50,
        trackResources: true,
        trackLongTasks: true,
        ...configuration,
      }),
      lifeCycle,
      createTrackingConsentState(TrackingConsent.GRANTED)
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
