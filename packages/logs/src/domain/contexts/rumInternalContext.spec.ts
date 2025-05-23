import type { TelemetryEvent } from '@flashcatcloud/browser-core'
import { startTelemetry, TelemetryService } from '@flashcatcloud/browser-core'
import { mockSyntheticsWorkerValues } from '@flashcatcloud/browser-core/test'
import { validateAndBuildLogsConfiguration } from '../configuration'
import { resetRUMInternalContext, getRUMInternalContext } from './rumInternalContext'

const initConfiguration = { clientToken: 'xxx', service: 'service' }

describe('getRUMInternalContext', () => {
  afterEach(() => {
    delete window.FC_RUM
    delete window.DD_RUM_SYNTHETICS
    resetRUMInternalContext()
  })

  it('returns undefined if no RUM instance is present', () => {
    expect(getRUMInternalContext()).toBeUndefined()
  })

  it('returns undefined if the global variable does not have a `getInternalContext` method', () => {
    window.FC_RUM = {} as any
    expect(getRUMInternalContext()).toBeUndefined()
  })

  it('returns the internal context from the `getInternalContext` method', () => {
    window.FC_RUM = {
      getInternalContext: () => ({ foo: 'bar' }),
    }
    expect(getRUMInternalContext()).toEqual({ foo: 'bar' })
  })

  describe('when RUM is injected by Synthetics', () => {
    let telemetrySpy: jasmine.Spy<(event: TelemetryEvent) => void>

    beforeEach(() => {
      mockSyntheticsWorkerValues({ injectsRum: true, publicId: 'test-id', resultId: 'result-id' })
      const telemetry = startTelemetry(
        TelemetryService.LOGS,
        validateAndBuildLogsConfiguration({ ...initConfiguration, telemetrySampleRate: 100 })!
      )
      telemetrySpy = jasmine.createSpy()
      telemetry.observable.subscribe(telemetrySpy)
    })

    it('uses the global variable created when the synthetics worker is injecting RUM', () => {
      window.DD_RUM_SYNTHETICS = {
        getInternalContext: () => ({ foo: 'bar' }),
      }
      expect(getRUMInternalContext()).toEqual({ foo: 'bar' })
    })

    it('adds a telemetry debug event when RUM has not been injected yet', () => {
      getRUMInternalContext()
      expect(telemetrySpy.calls.mostRecent().args[0].telemetry).toEqual(
        jasmine.objectContaining({
          message: 'Logs sent before RUM is injected by the synthetics worker',
          status: 'debug',
          type: 'log',
          testId: 'test-id',
          resultId: 'result-id',
        })
      )
    })

    it('adds the telemetry debug event only once', () => {
      getRUMInternalContext()
      getRUMInternalContext()
      expect(telemetrySpy).toHaveBeenCalledTimes(1)
    })
  })
})
