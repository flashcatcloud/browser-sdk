import {
  SESSION_STORE_KEY,
  STORAGE_POLL_DELAY,
  setCookie,
  createTrackingConsentState,
  TrackingConsent,
  stopSessionManager,
  Observable,
  createIdentityEncoder,
  noop,
} from '@flashcatcloud/browser-core'
import { getSessionState, interceptRequests, mockClock, registerCleanupTask } from '@flashcatcloud/browser-core/test'
import { createRumSessionManagerMock, mockRumConfiguration } from '../../test'
import { LifeCycle, LifeCycleEventType } from '../domain/lifeCycle'
import { startSessionErrorTracking } from '../domain/trackSessionError'
import { startRumSessionManager } from '../domain/rumSessionManager'
import type { RumEvent } from '../rumEvent.types'
import { startRumBatch } from './startRumBatch'

describe('withheld events through the real batch', () => {
  for (const released of [true, false]) {
    it(`observes a shared cookie release without a new RUM event (released=${released})`, () => {
      const clock = mockClock()
      const lifeCycle = new LifeCycle()
      const configuration = mockRumConfiguration({ sessionSampleRate: 0, sessionOnError: true })
      const session = startRumSessionManager(
        configuration,
        lifeCycle,
        createTrackingConsentState(TrackingConsent.GRANTED)
      )
      const requests = interceptRequests()
      const batch = startRumBatch(
        configuration,
        lifeCycle,
        new Observable(),
        noop,
        new Observable(),
        session,
        createIdentityEncoder
      )
      registerCleanupTask(() => {
        batch.stop()
        session.stop()
        stopSessionManager()
        clock.cleanup()
      })
      lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, {
        type: 'view',
        date: 1,
        session: { id: session.findTrackedSession()!.id },
        view: { id: 'view-id' },
      } as any)
      if (released) {
        setCookie(
          SESSION_STORE_KEY,
          Object.entries({ ...getSessionState(SESSION_STORE_KEY), hasError: '1' })
            .map(([key, value]) => `${key}=${value}`)
            .join('&'),
          60000
        )
      }
      clock.tick(STORAGE_POLL_DELAY + 3001)
      batch.flush('session_expire')
      const events = requests.requests.flatMap((request) =>
        request.body.split('\n').map((line) => JSON.parse(line) as RumEvent)
      )
      expect(events.map((event) => event.type)).toEqual(released ? ['view'] : [])
    })
  }

  for (const error of [true, false]) {
    it(`drains only released events when stopping (error=${error})`, () => {
      const clock = mockClock()
      const lifeCycle = new LifeCycle()
      const session = createRumSessionManagerMock().setTrackedOnError()
      const requests = interceptRequests()
      const tracker = startSessionErrorTracking(lifeCycle, session)
      const batch = startRumBatch(
        mockRumConfiguration(),
        lifeCycle,
        new Observable(),
        noop,
        new Observable(),
        session,
        createIdentityEncoder
      )
      registerCleanupTask(() => {
        tracker.stop()
        batch.stop()
        clock.cleanup()
      })
      const emit = (type: string) =>
        lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, {
          type,
          date: 1,
          session: { id: 'session-id' },
          view: { id: 'view-id' },
          error: { source: 'custom' },
        } as any)
      emit('view')
      if (error) {
        emit('error')
      }
      batch.stop()
      const events = requests.requests.flatMap((request) =>
        request.body.split('\n').map((line) => JSON.parse(line) as RumEvent)
      )
      expect(events.map((event) => event.type).sort()).toEqual(error ? ['error', 'view'] : [])
    })
  }
})
