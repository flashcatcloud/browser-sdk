import type { Context, ContextManager } from '@flashcatcloud/browser-core'
import { createContextManager } from '@flashcatcloud/browser-core'
import { registerCleanupTask } from '@flashcatcloud/browser-core/test'
import type { RumEvent } from '../rumEvent.types'
import { LifeCycle, LifeCycleEventType } from './lifeCycle'
import { CRASH_REPORT_BUFFER_BYTES, startCrashReportContext } from './crashReportContext'
import { STUB_SESSION_ID } from './rumSessionManager'

describe('startCrashReportContext', () => {
  let lifeCycle: LifeCycle
  let stored: Record<string, string>
  let initialize: jasmine.Spy
  let rejectKey: string | undefined
  /** Bytes the mock buffer holds (keys + values); `set` throws past it, as the browser does. */
  let capacity: number
  let userContext: ContextManager
  let resolveInitialize: () => void
  let rejectInitialize: (error: Error) => void

  function installCrashReport() {
    stored = {}
    rejectKey = undefined
    capacity = Infinity
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
        const used = Object.keys(stored)
          .filter((k) => k !== key)
          .reduce((n, k) => n + k.length + stored[k].length, 0)
        if (key === rejectKey || used + key.length + value.length > capacity) {
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
    stopContext = startCrashReportContext(lifeCycle, userContext).stop
    registerCleanupTask(stopContext)
  }

  function collectView(
    overrides: {
      usr?: { id?: string; anonymous_id?: string }
      viewId?: string
      viewName?: string
      isActive?: boolean
      sessionId?: string
      sampledForError?: boolean
    } = {}
  ) {
    lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, {
      type: 'view',
      session: { id: overrides.sessionId ?? 'session-id', sampled_for_error: overrides.sampledForError },
      view: {
        id: overrides.viewId ?? 'view-id',
        name: 'viewName' in overrides ? overrides.viewName : 'checkout',
        is_active: overrides.isActive ?? true,
      },
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
    userContext = createContextManager('user')
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
      rejectInitialize(new DOMException('already initialized', 'InvalidStateError'))
      await flushPromises()

      collectView()

      expect(stored.session_id).toBe('session-id')
    })

    it('writes nothing when the context could not be initialized', async () => {
      rejectInitialize(new DOMException('insecure context', 'NotAllowedError'))
      await flushPromises()

      collectView()

      expect(stored).toEqual({})
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

    it('does not attach crashes to the placeholder session of a bridged WebView', async () => {
      resolveInitialize()
      await flushPromises()

      collectView({ sessionId: STUB_SESSION_ID })

      expect(stored.session_id).toBeUndefined()
      expect(stored.view_id).toBeUndefined()
      expect(stored.version).toBe('1.2.3')
    })

    it('flags a session whose events are withheld until an error', async () => {
      resolveInitialize()
      await flushPromises()

      collectView({ sampledForError: true })
      expect(stored.session_sampled_for_error).toBe('1')

      collectView({ sessionId: 'next-session' })
      expect(stored.session_sampled_for_error).toBeUndefined()
    })

    it('does not store empty values', async () => {
      resolveInitialize()
      await flushPromises()

      collectView({ viewName: '' })

      expect('view_name' in stored).toBeFalse()
    })

    it('stops reporting the user as soon as it changes, until the next view update', async () => {
      resolveInitialize()
      await flushPromises()
      collectView()

      userContext.clearContext()
      expect(stored.usr_id).toBeUndefined()
      expect(stored.usr_anonymous_id).toBe('device-id')
      expect(stored.session_id).toBe('session-id')

      collectView({ usr: { id: 'next-user', anonymous_id: 'device-id' } })
      expect(stored.usr_id).toBe('next-user')
    })

    it('removes a value that no longer fits instead of keeping the previous one', async () => {
      resolveInitialize()
      await flushPromises()
      collectView({ viewName: 'home' })

      rejectKey = 'view_name'
      collectView({ viewName: 'a-name-that-does-not-fit' })

      expect('view_name' in stored).toBeFalse()
    })

    it('frees removed keys before writing new values', async () => {
      resolveInitialize()
      await flushPromises()
      collectView()
      capacity = Object.keys(stored).reduce((n, k) => n + k.length + stored[k].length, 0)

      // usr goes away and a longer view name comes in: it fits only once usr's room is freed
      collectView({ usr: undefined, viewName: 'checkout-and-more' })

      expect(stored.view_name).toBe('checkout-and-more')
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
