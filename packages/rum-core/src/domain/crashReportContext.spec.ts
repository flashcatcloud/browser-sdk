import type { Context } from '@flashcatcloud/browser-core'
import { registerCleanupTask } from '@flashcatcloud/browser-core/test'
import type { RumEvent } from '../rumEvent.types'
import { LifeCycle, LifeCycleEventType } from './lifeCycle'
import { CRASH_REPORT_BUFFER_BYTES, startCrashReportContext } from './crashReportContext'

describe('startCrashReportContext', () => {
  let lifeCycle: LifeCycle
  let stored: Record<string, string>
  let initialize: jasmine.Spy
  let rejectKey: string | undefined
  let resolveInitialize: () => void
  let rejectInitialize: (error: Error) => void

  function installCrashReport() {
    stored = {}
    rejectKey = undefined
    initialize = jasmine.createSpy('initialize').and.callFake(
      () =>
        new Promise<void>((resolve, reject) => {
          resolveInitialize = resolve
          rejectInitialize = reject
        })
    )
    const crashReport = {
      initialize,
      set: (key: string, value: string) => {
        if (key === rejectKey) {
          throw new Error('NotAllowedError')
        }
        stored[key] = value
      },
      delete: (key: string) => {
        delete stored[key]
      },
    }
    overrideCrashReport(crashReport)
  }

  // Chromium 145+ (the test browser) defines `crashReport` as a getter on Window.prototype; an own
  // property shadows it for the test and deleting it brings the real one back.
  function overrideCrashReport(value: unknown) {
    Object.defineProperty(window, 'crashReport', { value, configurable: true })
    registerCleanupTask(() => {
      delete (window as unknown as { crashReport?: unknown }).crashReport
    })
  }

  let stopContext: () => void

  function start() {
    stopContext = startCrashReportContext(lifeCycle).stop
    registerCleanupTask(stopContext)
  }

  function collectView(
    overrides: { usr?: { id?: string; anonymous_id?: string }; viewId?: string; isActive?: boolean } = {}
  ) {
    lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, {
      type: 'view',
      session: { id: 'session-id' },
      view: { id: overrides.viewId ?? 'view-id', name: 'checkout', is_active: overrides.isActive ?? true },
      version: '1.2.3',
      service: 'shop',
      usr: 'usr' in overrides ? overrides.usr : { id: 'user-id', anonymous_id: 'device-id' },
    } as unknown as RumEvent & Context)
  }

  function flushPromises() {
    return Promise.resolve().then(() => undefined)
  }

  beforeEach(() => {
    lifeCycle = new LifeCycle()
  })

  it('does nothing when the browser has no crash report context', () => {
    overrideCrashReport(undefined)
    start()
    expect(() => collectView()).not.toThrow()
  })

  describe('with a crash report context', () => {
    beforeEach(() => {
      installCrashReport()
      start()
    })

    it('reserves the buffer once', () => {
      expect(initialize).toHaveBeenCalledOnceWith(CRASH_REPORT_BUFFER_BYTES)
    })

    it('waits for the context to be initialized, then writes the latest view', async () => {
      collectView({ viewId: 'first-view' })
      collectView({ viewId: 'second-view' })
      expect(stored).toEqual({})

      resolveInitialize()
      await flushPromises()

      expect(stored).toEqual({
        session_id: 'session-id',
        view_id: 'second-view',
        view_name: 'checkout',
        version: '1.2.3',
        service: 'shop',
        usr_id: 'user-id',
        usr_anonymous_id: 'device-id',
      })
    })

    it('still writes when the page had already initialized the context itself', async () => {
      rejectInitialize(new Error('InvalidStateError'))
      await flushPromises()

      collectView()

      expect(stored.session_id).toBe('session-id')
    })

    it('follows the current view and removes keys that are no longer set', async () => {
      resolveInitialize()
      await flushPromises()

      collectView()
      collectView({ viewId: 'next-view', usr: undefined })

      expect(stored.view_id).toBe('next-view')
      expect(stored.usr_id).toBeUndefined()
      expect(stored.usr_anonymous_id).toBeUndefined()
    })

    it('ignores events other than views', async () => {
      resolveInitialize()
      await flushPromises()

      lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, {
        type: 'error',
        session: { id: 'other-session' },
        view: { id: 'other-view' },
      } as unknown as RumEvent & Context)

      expect(stored).toEqual({})
    })

    it('keeps the active view when an ended view sends its last update', async () => {
      resolveInitialize()
      await flushPromises()

      collectView({ viewId: 'next-view' })
      collectView({ viewId: 'previous-view', isActive: false })

      expect(stored.view_id).toBe('next-view')
    })

    it('clears the keys when the session expires, and the ended view does not bring them back', async () => {
      resolveInitialize()
      await flushPromises()
      collectView()

      lifeCycle.notify(LifeCycleEventType.SESSION_EXPIRED)
      collectView({ isActive: false })

      expect(stored).toEqual({})
    })

    it('clears the keys when stopped', async () => {
      resolveInitialize()
      await flushPromises()
      collectView()

      stopContext()

      expect(stored).toEqual({})
    })

    it('writes the other keys when one of them does not fit', async () => {
      resolveInitialize()
      await flushPromises()
      rejectKey = 'view_name'

      collectView()

      expect(stored.view_name).toBeUndefined()
      expect(stored.view_id).toBe('view-id')
      expect(stored.session_id).toBe('session-id')
    })
  })
})
