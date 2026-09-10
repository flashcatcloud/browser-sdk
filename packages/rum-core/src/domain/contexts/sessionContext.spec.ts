import type { RelativeTime } from '@flashcatcloud/browser-core'
import { clocksNow, DISCARDED, HookNames } from '@flashcatcloud/browser-core'
import type { RumSessionManagerMock } from '../../../test'
import { createRumSessionManagerMock, noopRecorderApi } from '../../../test'
import { SessionType } from '../rumSessionManager'
import type { DefaultRumEventAttributes, Hooks } from '../hooks'
import { createHooks } from '../hooks'
import { startSessionContext } from './sessionContext'
import type { ViewHistory } from './viewHistory'

describe('session context', () => {
  let hooks: Hooks
  let viewHistory: ViewHistory
  let sessionManager: RumSessionManagerMock
  const fakeView = {
    id: '1',
    startClocks: clocksNow(),
    sessionIsActive: false,
  }
  let isRecordingSpy: jasmine.Spy
  let getReplayStatsSpy: jasmine.Spy
  let findViewSpy: jasmine.Spy
  const fakeStats = {
    segments_count: 4,
    records_count: 10,
    segments_total_raw_size: 1000,
  }

  beforeEach(() => {
    viewHistory = { findView: () => undefined } as ViewHistory
    hooks = createHooks()
    sessionManager = createRumSessionManagerMock()
    const recorderApi = noopRecorderApi

    isRecordingSpy = spyOn(recorderApi, 'isRecording')
    getReplayStatsSpy = spyOn(recorderApi, 'getReplayStats')
    findViewSpy = spyOn(viewHistory, 'findView').and.returnValue(fakeView)

    startSessionContext(hooks, sessionManager, recorderApi, viewHistory)
  })

  it('should set id and type', () => {
    isRecordingSpy.and.returnValue(true)

    const defaultRumEventAttributes = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'action',
      startTime: 0 as RelativeTime,
    })

    expect(defaultRumEventAttributes).toEqual({
      type: 'action',
      session: jasmine.objectContaining({
        id: jasmine.any(String),
        type: SessionType.USER,
      }),
    })
  })

  it('should set hasReplay when recording has started (isRecording) on events', () => {
    isRecordingSpy.and.returnValue(true)
    const eventWithHasReplay = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'action',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    isRecordingSpy.and.returnValue(false)
    const eventWithoutHasReplay = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'action',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(getReplayStatsSpy).not.toHaveBeenCalled()
    expect(isRecordingSpy).toHaveBeenCalled()
    expect(eventWithHasReplay.session!.has_replay).toEqual(true)
    expect(eventWithoutHasReplay.session!.has_replay).toBeUndefined()
  })

  it('should set hasReplay when there are Replay stats on view events', () => {
    getReplayStatsSpy.and.returnValue(fakeStats)
    const eventWithHasReplay = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    getReplayStatsSpy.and.returnValue(undefined)
    const eventWithoutHasReplay = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(getReplayStatsSpy).toHaveBeenCalled()
    expect(isRecordingSpy).not.toHaveBeenCalled()
    expect(eventWithHasReplay.session!.has_replay).toEqual(true)
    expect(eventWithoutHasReplay.session!.has_replay).toBeUndefined()
  })

  it('should tell a replay kept only because the session errored apart from an unconditional one', () => {
    sessionManager.setTrackedWithErrorSessionReplay()
    const errorReplayEvent = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    sessionManager.setTrackedWithSessionReplay()
    const plainEvent = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(errorReplayEvent.session!.sampled_for_error_replay).toBeTrue()
    // absent rather than false, so it costs nothing on every ordinary session
    expect(plainEvent.session!.sampled_for_error_replay).toBeUndefined()
  })

  it('does not report sampled_for_replay for an error-replay session that has not errored', () => {
    // a type-3 session withholds only its replay, not its events; its events ship on their own, so
    // reporting sampled_for_replay before the error would claim a replay for a recording that may
    // never be sent
    sessionManager.setTrackedWithErrorSessionReplay()

    const event = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(event.session!.sampled_for_replay).toBe(false)
  })

  it('should not set hasReplay when a dropped buffer left the view with nothing', () => {
    // a withheld buffer that was dropped rolls back what it held, and a view left with an empty
    // stats entry has no replay to offer
    getReplayStatsSpy.and.returnValue({ segments_count: 0, records_count: 0, segments_total_raw_size: 0 })

    const event = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(event.session!.has_replay).toBeUndefined()
  })

  it('should set hasReplay when a host bridge took the records and no segment was built', () => {
    // records go straight to the bridge, so nothing ever counts a segment for them
    getReplayStatsSpy.and.returnValue({ ...fakeStats, segments_count: 0, records_count: 10 })

    const event = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(event.session!.has_replay).toBe(true)
  })

  it('should set session.is_active when the session is active', () => {
    findViewSpy.and.returnValue({ ...fakeView, sessionIsActive: true })
    const eventWithActiveSession = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes
    findViewSpy.and.returnValue({ ...fakeView, sessionIsActive: false })
    const eventWithoutActiveSession = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(eventWithActiveSession.session!.is_active).toBe(undefined)
    expect(eventWithoutActiveSession.session!.is_active).toBe(false)
  })

  it('should set sampled_for_replay', () => {
    sessionManager.setTrackedWithSessionReplay()
    const eventSampleForReplay = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    sessionManager.setTrackedWithoutSessionReplay()
    const eventSampledOutForReplay = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(eventSampleForReplay.session!.sampled_for_replay).toBe(true)
    expect(eventSampledOutForReplay.session!.sampled_for_replay).toBe(false)
  })

  it('should set sampled_for_replay on a session whose events are withheld alongside its replay', () => {
    // these events only ever leave together with that replay, so reporting the state as it stands
    // while they are held would mark the whole released burst as having none
    sessionManager.setTrackedOnErrorWithSessionReplay()

    const event = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(event.session!.sampled_for_replay).toBe(true)
  })

  it('should not claim a replay while one is withheld, whichever way it turns out', () => {
    // the segment covering this event is dropped on the next view change and sent only if the error
    // comes first; the event is assembled before either, so it claims nothing
    sessionManager.setTrackedOnErrorWithSessionReplay()
    isRecordingSpy.and.returnValue(true)
    getReplayStatsSpy.and.returnValue(fakeStats)

    const errorEvent = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'error',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes
    const viewEvent = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(errorEvent.session!.has_replay).toBeUndefined()
    expect(viewEvent.session!.has_replay).toBeUndefined()
    // but the session was sampled for one, and that is answerable without knowing any segment's fate
    expect(viewEvent.session!.sampled_for_replay).toBe(true)
  })

  it('should not claim a replay for a session that withholds its events and has none', () => {
    sessionManager.setTrackedOnError()

    const event = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(event.session!.sampled_for_replay).toBe(false)
  })

  it('should tell the backend a session was stored only because it errored', () => {
    sessionManager.setTrackedOnError()
    const onErrorEvent = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    sessionManager.setTrackedWithSessionReplay()
    const plainEvent = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(onErrorEvent.session!.sampled_for_error).toBeTrue()
    // absent rather than false, so it costs nothing on every ordinary session
    expect(plainEvent.session!.sampled_for_error).toBeUndefined()
  })

  it('should report the configuration the session was drawn under', () => {
    sessionManager.setDrawnConfiguration({
      version: 12,
      sessionSampleRate: 100,
      sessionReplaySampleRate: 25,
      traceSampleRate: 100,
      defaultPrivacyLevel: 'mask',
    })

    const defaultRumEventAttributes = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'action',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(defaultRumEventAttributes._dd).toEqual({
      configuration: {
        session_sample_rate: 100,
        session_replay_sample_rate: 25,
        rc_version: 12,
      } as NonNullable<DefaultRumEventAttributes['_dd']>['configuration'],
    })
  })

  it('should not override the configuration when the session has no draw record', () => {
    const defaultRumEventAttributes = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'action',
      startTime: 0 as RelativeTime,
    }) as DefaultRumEventAttributes

    expect(defaultRumEventAttributes._dd).toBeUndefined()
  })

  it('should discard the event if no session', () => {
    sessionManager.setNotTracked()
    const defaultRumEventAttributes = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    })

    expect(defaultRumEventAttributes).toBe(DISCARDED)
  })

  it('should discard the event if no view', () => {
    findViewSpy.and.returnValue(undefined)
    const defaultRumEventAttributes = hooks.triggerHook(HookNames.Assemble, {
      eventType: 'view',
      startTime: 0 as RelativeTime,
    })

    expect(defaultRumEventAttributes).toBe(DISCARDED)
  })
})
