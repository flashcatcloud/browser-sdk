import type { RawError, Subscription } from '@flashcatcloud/browser-core'
import { ErrorHandling, ErrorSource, Observable, clocksNow } from '@flashcatcloud/browser-core'
import type { Clock, MockCspEventListener, MockReportingObserver } from '@flashcatcloud/browser-core/test'
import {
  FAKE_CSP_VIOLATION_EVENT,
  FAKE_REPORT,
  mockClock,
  mockCspEventListener,
  mockReportingObserver,
  registerCleanupTask,
} from '@flashcatcloud/browser-core/test'
import { mockRumConfiguration } from '../../../test'
import type { RumConfiguration } from '../configuration'
import { trackReportError } from './trackReportError'

describe('trackReportError', () => {
  let errorObservable: Observable<RawError>
  let subscription: Subscription
  let notifyLog: jasmine.Spy
  let clock: Clock
  let reportingObserver: MockReportingObserver
  let cspEventListener: MockCspEventListener
  let configuration: RumConfiguration

  beforeEach(() => {
    if (!window.ReportingObserver) {
      pending('ReportingObserver not supported')
    }
    configuration = mockRumConfiguration()
    errorObservable = new Observable()
    notifyLog = jasmine.createSpy('notifyLog')
    reportingObserver = mockReportingObserver()
    subscription = errorObservable.subscribe(notifyLog)
    clock = mockClock()
    registerCleanupTask(() => {
      subscription.unsubscribe()
      clock.cleanup()
    })
    cspEventListener = mockCspEventListener()
  })

  it('should track reports', () => {
    trackReportError(configuration, errorObservable)
    reportingObserver.raiseReport('intervention')

    expect(notifyLog).toHaveBeenCalledWith({
      startClocks: clocksNow(),
      message: jasmine.any(String),
      stack: jasmine.any(String),
      source: ErrorSource.REPORT,
      handling: ErrorHandling.UNHANDLED,
      type: 'NavigatorVibrate',
      originalError: FAKE_REPORT,
    })
  })

  it('should track securitypolicyviolation', () => {
    trackReportError(configuration, errorObservable)
    cspEventListener.dispatchEvent()

    expect(notifyLog).toHaveBeenCalledWith({
      startClocks: clocksNow(),
      message: jasmine.any(String),
      stack: jasmine.any(String),
      source: ErrorSource.REPORT,
      handling: ErrorHandling.UNHANDLED,
      type: FAKE_CSP_VIOLATION_EVENT.effectiveDirective,
      originalError: FAKE_CSP_VIOLATION_EVENT,
      csp: {
        disposition: FAKE_CSP_VIOLATION_EVENT.disposition,
      },
    })
  })
})
