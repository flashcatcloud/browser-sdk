import type { Context } from '@flashcatcloud/browser-core'
import { registerCleanupTask } from '@flashcatcloud/browser-core/test'
import type { RumEvent } from '../rumEvent.types'
import { createRumSessionManagerMock } from '../../test'
import { LifeCycle, LifeCycleEventType } from './lifeCycle'
import { startSessionErrorTracking } from './trackSessionError'

describe('startSessionErrorTracking', () => {
  let lifeCycle: LifeCycle
  let sessionManager: ReturnType<typeof createRumSessionManagerMock>
  let setSessionHasErrorSpy: jasmine.Spy

  function collect(type: string, source = 'source') {
    lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, { type, error: { source } } as unknown as RumEvent &
      Context)
  }

  beforeEach(() => {
    lifeCycle = new LifeCycle()
    sessionManager = createRumSessionManagerMock()
    setSessionHasErrorSpy = spyOn(sessionManager, 'setSessionHasError').and.callThrough()
    const { stop } = startSessionErrorTracking(lifeCycle, sessionManager)
    registerCleanupTask(stop)
  })

  it('marks the session on the first collected error', () => {
    collect('error')

    expect(setSessionHasErrorSpy).toHaveBeenCalledTimes(1)
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
    const { stop } = startSessionErrorTracking(lifeCycle, sessionManager)
    stop()
    setSessionHasErrorSpy.calls.reset()
    // the suite's own tracker is still running, so exactly one call is expected, not two
    collect('error')

    expect(setSessionHasErrorSpy).toHaveBeenCalledTimes(1)
  })
})
