import type { RelativeTime } from '@flashcatcloud/browser-core'
import {
  STORAGE_POLL_DELAY,
  SESSION_STORE_KEY,
  setCookie,
  stopSessionManager,
  ONE_SECOND,
  DOM_EVENT,
  createTrackingConsentState,
  TrackingConsent,
  BridgeCapability,
  isChromium,
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

  describe('error session replay sampling', () => {
    it('draws the error-replay type only when the plain replay draw missed', () => {
      startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 100, sessionReplayOnErrorSampleRate: 100 },
      })

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITH_SESSION_REPLAY)
    })

    it('stores the error-replay type when only that rate is hit', () => {
      startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 0, sessionReplayOnErrorSampleRate: 100 },
      })

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(
        RumTrackingType.TRACKED_WITH_ERROR_SESSION_REPLAY
      )
    })

    it('withholds the replay until the session reports an error', () => {
      const sessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 0, sessionReplayOnErrorSampleRate: 100 },
      })

      expect(sessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.BUFFERED_ON_ERROR)

      sessionManager.setSessionHasError(sessionManager.findTrackedSession()!.id)

      expect(sessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.SAMPLED)
    })

    it('does not mark a session that has since been replaced by another one', () => {
      const sessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 0, sessionReplayOnErrorSampleRate: 100 },
      })

      // another tab renewed the session while the mark was on its way to the store
      setCookie(SESSION_STORE_KEY, 'id=other-session&rum=3', DURATION)

      sessionManager.setSessionHasError('a-session-that-is-gone')

      expect(getSessionState(SESSION_STORE_KEY).hasError).toBeUndefined()
    })

    it('releases the replay before the store write lands, since that write can be deferred', () => {
      if (!isChromium()) {
        pending('the store lock, and so a deferred write, only exists on Chromium')
      }
      const sessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 0, sessionReplayOnErrorSampleRate: 100 },
      })
      const sessionId = sessionManager.findTrackedSession()!.id

      // another tab holds the store lock, so the write is deferred through retries
      setCookie(SESSION_STORE_KEY, `lock=other-tab&id=${sessionId}&rum=3`, DURATION)

      sessionManager.setSessionHasError(sessionId)

      expect(getSessionState(SESSION_STORE_KEY).hasError).toBeUndefined()
      // and yet the buffer must already see it as released: the page or the session may end before
      // the write ever lands, and the buffer would otherwise be thrown away
      expect(sessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.SAMPLED)
    })

    it('keeps the released state across a page load, since it is persisted in the session store', () => {
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=3&hasError=1', DURATION)

      const sessionManager = startRumSessionManagerWithDefaults()

      expect(sessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.SAMPLED)
    })

    it('marks the session so a replay kept only because it errored can be told apart', () => {
      const sessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 0, sessionReplayOnErrorSampleRate: 100 },
      })

      expect(sessionManager.findTrackedSession()!.sampledOnErrorReplay).toBeTrue()

      // still true once released, so what was stored can be told apart afterwards
      sessionManager.setSessionHasError(sessionManager.findTrackedSession()!.id)

      expect(sessionManager.findTrackedSession()!.sampledOnErrorReplay).toBeTrue()
    })

    it('does not mark a session whose replay is collected unconditionally', () => {
      const sessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 100 },
      })

      expect(sessionManager.findTrackedSession()!.sampledOnErrorReplay).toBeFalse()
    })

    it('releases the replay when it is forced, rather than waiting for an error that may never come', () => {
      const sessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 0, sessionReplayOnErrorSampleRate: 100 },
      })
      expect(sessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.BUFFERED_ON_ERROR)

      sessionManager.setForcedReplay()

      expect(sessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.FORCED)
    })

    it('tracks the session even when no replay rate is hit at all', () => {
      const sessionManager = startRumSessionManagerWithDefaults({
        configuration: { sessionSampleRate: 100, sessionReplaySampleRate: 0, sessionReplayOnErrorSampleRate: 0 },
      })

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY)
      expect(sessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.OFF)
    })
  })

  describe('on-error session sampling', () => {
    const ON_ERROR_ONLY = {
      sessionSampleRate: 0,
      sessionOnErrorSampleRate: 100,
      sessionReplaySampleRate: 0,
      sessionReplayOnErrorSampleRate: 0,
    }

    it('draws the on-error type only when the plain session draw missed', () => {
      startRumSessionManagerWithDefaults({
        configuration: { ...ON_ERROR_ONLY, sessionSampleRate: 100 },
      })

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(RumTrackingType.TRACKED_WITHOUT_SESSION_REPLAY)
    })

    it('withholds the events of a session drawn on error', () => {
      const sessionManager = startRumSessionManagerWithDefaults({ configuration: ON_ERROR_ONLY })

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(
        RumTrackingType.TRACKED_ON_ERROR_WITHOUT_SESSION_REPLAY
      )
      expect(sessionManager.findTrackedSession()!.eventsWithheld).toBeTrue()

      sessionManager.setSessionHasError(sessionManager.findTrackedSession()!.id)

      expect(sessionManager.findTrackedSession()!.eventsWithheld).toBeFalse()
    })

    it('withholds the replay alongside the events, even when the plain replay rate was drawn', () => {
      // a replay uploaded while the events are withheld would have no session to attach to
      const sessionManager = startRumSessionManagerWithDefaults({
        configuration: { ...ON_ERROR_ONLY, sessionReplaySampleRate: 100 },
      })

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(
        RumTrackingType.TRACKED_ON_ERROR_WITH_SESSION_REPLAY
      )
      expect(sessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.BUFFERED_ON_ERROR)
    })

    it('releases events and replay together on the first error', () => {
      const sessionManager = startRumSessionManagerWithDefaults({
        configuration: { ...ON_ERROR_ONLY, sessionReplaySampleRate: 100 },
      })

      sessionManager.setSessionHasError(sessionManager.findTrackedSession()!.id)

      const session = sessionManager.findTrackedSession()!
      expect(session.eventsWithheld).toBeFalse()
      expect(session.sessionReplay).toBe(SessionReplayState.SAMPLED)
    })

    it('releases the events when capture is forced, so the forced replay is not left orphaned', () => {
      const sessionManager = startRumSessionManagerWithDefaults({
        configuration: { ...ON_ERROR_ONLY, sessionReplaySampleRate: 100 },
      })

      sessionManager.setForcedReplay()

      const session = sessionManager.findTrackedSession()!
      expect(session.eventsWithheld).toBeFalse()
      expect(session.sessionReplay).toBe(SessionReplayState.FORCED)
    })

    it('draws the type that withholds the replay too when only the on-error replay rate is set', () => {
      const sessionManager = startRumSessionManagerWithDefaults({
        configuration: { ...ON_ERROR_ONLY, sessionReplayOnErrorSampleRate: 100 },
      })

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(
        RumTrackingType.TRACKED_ON_ERROR_WITH_SESSION_REPLAY
      )
      expect(sessionManager.findTrackedSession()!.sessionReplay).toBe(SessionReplayState.BUFFERED_ON_ERROR)
    })

    it('keeps a stored on-error type across a page load rather than drawing again', () => {
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=4', DURATION)

      // a rate that would draw a plainly tracked session, so honouring the stored type is the only
      // way this can still be an on-error one
      const sessionManager = startRumSessionManagerWithDefaults({ configuration: { sessionSampleRate: 100 } })

      expect(getSessionState(SESSION_STORE_KEY)[RUM_SESSION_KEY]).toBe(
        RumTrackingType.TRACKED_ON_ERROR_WITHOUT_SESSION_REPLAY
      )
      expect(sessionManager.findTrackedSession()!.eventsWithheld).toBeTrue()
    })

    it('keeps a released on-error session released across a page load', () => {
      setCookie(SESSION_STORE_KEY, 'id=abcdef&rum=5&hasError=1', DURATION)

      const sessionManager = startRumSessionManagerWithDefaults({ configuration: { sessionSampleRate: 100 } })

      const session = sessionManager.findTrackedSession()!
      expect(session.eventsWithheld).toBeFalse()
      expect(session.sampledOnError).toBeTrue()
      expect(session.sessionReplay).toBe(SessionReplayState.SAMPLED)
    })

    it('keeps marking the session as on-error once its events have been released', () => {
      const sessionManager = startRumSessionManagerWithDefaults({ configuration: ON_ERROR_ONLY })
      sessionManager.setSessionHasError(sessionManager.findTrackedSession()!.id)

      expect(sessionManager.findTrackedSession()!.sampledOnError).toBeTrue()
    })
  })

  function startRumSessionManagerWithDefaults({ configuration }: { configuration?: Partial<RumConfiguration> } = {}) {
    return startRumSessionManager(
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
  }
})

describe('rum session manager stub', () => {
  it('should return a tracked session with replay allowed when the event bridge support records', () => {
    mockEventBridge({ capabilities: [BridgeCapability.RECORDS] })
    expect(startRumSessionManagerStub().findTrackedSession()!.sessionReplay).toEqual(SessionReplayState.SAMPLED)
  })

  it('should return a tracked session without replay allowed when the event bridge support records', () => {
    mockEventBridge({ capabilities: [] })
    expect(startRumSessionManagerStub().findTrackedSession()!.sessionReplay).toEqual(SessionReplayState.OFF)
  })
})
