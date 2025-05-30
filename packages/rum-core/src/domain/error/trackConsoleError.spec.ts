import type { RawError, Subscription } from '@flashcatcloud/browser-core'
import { ErrorHandling, ErrorSource, Observable, clocksNow, resetConsoleObservable } from '@flashcatcloud/browser-core'
import type { Clock } from '@flashcatcloud/browser-core/test'
import { ignoreConsoleLogs, mockClock } from '@flashcatcloud/browser-core/test'
import { trackConsoleError } from './trackConsoleError'

describe('trackConsoleError', () => {
  let errorObservable: Observable<RawError>
  let subscription: Subscription
  let notifyLog: jasmine.Spy
  let clock: Clock

  beforeEach(() => {
    ignoreConsoleLogs('error', 'Error: foo')
    errorObservable = new Observable()
    notifyLog = jasmine.createSpy('notifyLog')
    trackConsoleError(errorObservable)
    subscription = errorObservable.subscribe(notifyLog)
    clock = mockClock()
  })

  afterEach(() => {
    resetConsoleObservable()
    subscription.unsubscribe()
    clock.cleanup()
  })

  it('should track console error', () => {
    const error = new TypeError('foo')

    // eslint-disable-next-line no-console
    console.error(error)

    expect(notifyLog).toHaveBeenCalledWith({
      startClocks: clocksNow(),
      message: jasmine.any(String),
      stack: jasmine.any(String),
      source: ErrorSource.CONSOLE,
      handling: ErrorHandling.HANDLED,
      handlingStack: jasmine.any(String),
      fingerprint: undefined,
      causes: undefined,
      context: undefined,
      originalError: error,
      type: 'TypeError',
      componentStack: undefined,
    })
  })

  it('should retrieve fingerprint from console error', () => {
    interface DatadogError extends Error {
      dd_fingerprint?: string
    }
    const error = new Error('foo')
    ;(error as DatadogError).dd_fingerprint = 'my-fingerprint'

    // eslint-disable-next-line no-console
    console.error(error)

    expect(notifyLog).toHaveBeenCalledWith({
      startClocks: clocksNow(),
      message: jasmine.any(String),
      stack: jasmine.any(String),
      source: ErrorSource.CONSOLE,
      handling: ErrorHandling.HANDLED,
      handlingStack: jasmine.any(String),
      fingerprint: 'my-fingerprint',
      causes: undefined,
      context: undefined,
      originalError: error,
      type: 'Error',
      componentStack: undefined,
    })
  })
})
