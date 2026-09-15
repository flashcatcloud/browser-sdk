import type { Context } from '@flashcatcloud/browser-core'
import { registerCleanupTask } from '@flashcatcloud/browser-core/test'
import type { RumEvent } from '../rumEvent.types'
import { createRumSessionManagerMock, noopRecorderApi } from '../../test'
import type { RecorderApi } from '../boot/rumPublicApi'
import { LifeCycle, LifeCycleEventType } from './lifeCycle'
import { startSessionErrorTracking } from './trackSessionError'

describe('startSessionErrorTracking', () => {
  let lifeCycle: LifeCycle
  let sessionManager: ReturnType<typeof createRumSessionManagerMock>
  let setSessionHasErrorSpy: jasmine.Spy
  /** Records the recorder still holds for the error's view, or undefined when it never recorded it. */
  let viewRecords: number | undefined
  let recorderApi: RecorderApi

  function collect(type: string, source = 'source') {
    // only error events carry an `error` object; anything else that did would hide a guard that
    // reads it before checking the type
    const event = (type === 'error'
      ? { type, session: { id: 'session-id' }, view: { id: 'view-id' }, error: { source } }
      : { type }) as unknown as RumEvent & Context
    lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, event)
    return event
  }

  beforeEach(() => {
    lifeCycle = new LifeCycle()
    sessionManager = createRumSessionManagerMock().setTrackedWithErrorSessionReplay()
    setSessionHasErrorSpy = spyOn(sessionManager, 'setSessionHasError').and.callThrough()
    viewRecords = 3
    recorderApi = {
      ...noopRecorderApi,
      // only the error's own view has stats, so a claim read off any other view would not be made
      getReplayStats: (viewId) =>
        viewId === 'view-id' && viewRecords !== undefined
          ? { records_count: viewRecords, segments_count: 1, segments_total_raw_size: 10 }
          : undefined,
    }
    const { stop } = startSessionErrorTracking(lifeCycle, sessionManager, recorderApi)
    registerCleanupTask(stop)
  })

  it('ignores an error from an earlier session without consuming the current session mark', () => {
    lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, {
      type: 'error',
      session: { id: 'previous-session' },
      error: { source: 'custom' },
    } as unknown as RumEvent & Context)
    expect(setSessionHasErrorSpy).not.toHaveBeenCalled()
    collect('error')
    expect(setSessionHasErrorSpy).toHaveBeenCalledOnceWith('session-id')
  })

  it('does not attribute an error without a session id to the current session', () => {
    lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, {
      type: 'error',
      error: { source: 'custom' },
    } as unknown as RumEvent & Context)
    expect(setSessionHasErrorSpy).not.toHaveBeenCalled()
  })

  it('marks the session on the first collected error', () => {
    collect('error')

    // named, not just counted: the mark is refused if it does not name the session it belongs to
    expect(setSessionHasErrorSpy).toHaveBeenCalledOnceWith('session-id')
  })

  it('claims the replay on the error that releases a withheld one', () => {
    // the error was assembled while the replay was withheld, so nothing else will ever claim it
    const error = collect('error')

    expect(error.session.has_replay).toBeTrue()
  })

  it('claims no replay on the releasing error when its view kept no records, even while recording', () => {
    // every withheld segment of the view was dropped, which gives its records back
    viewRecords = 0

    const error = collect('error')

    expect(error.session.has_replay).toBeUndefined()
  })

  it('claims no replay on the releasing error when its view was never recorded', () => {
    viewRecords = undefined

    const error = collect('error')

    expect(error.session.has_replay).toBeUndefined()
  })

  it('claims no replay on the releasing error of a session that withholds only its events', () => {
    sessionManager.setTrackedOnError()

    const error = collect('error')

    expect(error.session.has_replay).toBeUndefined()
  })

  it('leaves the replay claim of an error from a session that withholds nothing to the assembly', () => {
    sessionManager.setTrackedWithSessionReplay()

    const error = collect('error')

    expect(error.session.has_replay).toBeUndefined()
  })

  it('leaves a session that withholds nothing alone, so an ordinary session store is never written', () => {
    sessionManager.setTrackedWithSessionReplay()

    collect('error')

    expect(setSessionHasErrorSpy).not.toHaveBeenCalled()
  })

  it('marks a session that withholds only its events, which has no replay to release', () => {
    sessionManager.setTrackedOnError()

    collect('error')

    expect(setSessionHasErrorSpy).toHaveBeenCalledTimes(1)
  })

  it('leaves an untracked session alone', () => {
    sessionManager.setNotTracked()

    collect('error')

    expect(setSessionHasErrorSpy).not.toHaveBeenCalled()
  })

  it('does not mark the session on other event types', () => {
    collect('view')
    collect('resource')
    collect('action')

    expect(setSessionHasErrorSpy).not.toHaveBeenCalled()
  })

  it('ignores the SDK own failures, which are not the application reporting an error', () => {
    collect('error', 'agent')

    expect(setSessionHasErrorSpy).not.toHaveBeenCalled()
  })

  it('still marks the session on a network error, which is the application reporting one', () => {
    collect('error', 'network')

    expect(setSessionHasErrorSpy).toHaveBeenCalledTimes(1)
  })

  it('marks the session only once, however many errors follow', () => {
    collect('error')
    collect('error')
    collect('error')

    expect(setSessionHasErrorSpy).toHaveBeenCalledTimes(1)
  })

  it('marks a renewed session again, since it is a different session', () => {
    collect('error')
    lifeCycle.notify(LifeCycleEventType.SESSION_RENEWED)
    collect('error')

    expect(setSessionHasErrorSpy).toHaveBeenCalledTimes(2)
  })

  it('stops marking once stopped', () => {
    const { stop } = startSessionErrorTracking(lifeCycle, sessionManager, recorderApi)
    stop()
    setSessionHasErrorSpy.calls.reset()
    // the suite's own tracker is still running, so exactly one call is expected, not two
    collect('error')

    expect(setSessionHasErrorSpy).toHaveBeenCalledTimes(1)
  })
})
