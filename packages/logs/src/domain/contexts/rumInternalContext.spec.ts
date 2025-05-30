import type { Context, RelativeTime, TelemetryEvent } from '@flashcatcloud/browser-core'
import { HookNames, startTelemetry, TelemetryService } from '@flashcatcloud/browser-core'
import { mockSyntheticsWorkerValues } from '@flashcatcloud/browser-core/test'
import { validateAndBuildLogsConfiguration } from '../configuration'
import type { Hooks } from '../hooks'
import { createHooks } from '../hooks'
import { startRUMInternalContext } from './rumInternalContext'

const initConfiguration = { clientToken: 'xxx', service: 'service' }

describe('startRUMInternalContext', () => {
  let hooks: Hooks
  let stopRUMInternalContext: () => void
  let getRUMInternalContext: (startTime?: RelativeTime) => Context | undefined

  beforeEach(() => {
    hooks = createHooks()
    ;({ stop: stopRUMInternalContext, getRUMInternalContext } = startRUMInternalContext(hooks))
  })

  afterEach(() => {
    delete window.FC_RUM
    delete window.DD_RUM_SYNTHETICS
    stopRUMInternalContext()
  })

  it('returns undefined if no RUM instance is present', () => {
    const defaultLogsEventAttributes = hooks.triggerHook(HookNames.Assemble, {
      startTime: 0 as RelativeTime,
    })

    expect(defaultLogsEventAttributes).toBeUndefined()
  })

  it('returns undefined if the global variable does not have a `getInternalContext` method', () => {
    window.FC_RUM = {} as any
    const defaultLogsEventAttributes = hooks.triggerHook(HookNames.Assemble, {
      startTime: 0 as RelativeTime,
    })
    expect(defaultLogsEventAttributes).toBeUndefined()
  })

  it('returns the internal context from the `getInternalContext` method', () => {
    window.FC_RUM = {
      getInternalContext: () => ({ foo: 'bar' }),
    }
    const defaultLogsEventAttributes = hooks.triggerHook(HookNames.Assemble, {
      startTime: 0 as RelativeTime,
    })
    expect(defaultLogsEventAttributes).toEqual({ foo: 'bar' })
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
      const defaultLogsEventAttributes = hooks.triggerHook(HookNames.Assemble, {
        startTime: 0 as RelativeTime,
      })
      expect(defaultLogsEventAttributes).toEqual({ foo: 'bar' })
    })

    it('adds a telemetry debug event when RUM has not been injected yet', () => {
      hooks.triggerHook(HookNames.Assemble, {
        startTime: 0 as RelativeTime,
      })
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
      hooks.triggerHook(HookNames.Assemble, {
        startTime: 0 as RelativeTime,
      })
      hooks.triggerHook(HookNames.Assemble, {
        startTime: 0 as RelativeTime,
      })
      expect(telemetrySpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('getRUMInternalContext', () => {
    it('should get the RUM internal context', () => {
      window.DD_RUM = {
        getInternalContext: () => ({ foo: 'bar' }),
      }
      const rumInternalContext = getRUMInternalContext()
      expect(rumInternalContext).toEqual({ foo: 'bar' })
    })
  })
})
