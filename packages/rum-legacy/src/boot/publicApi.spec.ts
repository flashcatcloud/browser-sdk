import type { BuildEnvWindow } from '../../../core/test'
import { COOKIE_ACCESS_DELAY, deleteSessionCookie } from '../domain/sessionStore'
import { BATCH_BYTES_LIMIT, FLUSH_TIMEOUT } from '../transport/batch'
import { makeRumLegacyPublicApi } from './publicApi'

/**
 * These specs drive the whole package end to end: the public api, collection, assembly, batching
 * and the transport, with only XMLHttpRequest faked. What lands in `payloads` is what a browser
 * would actually put on the wire.
 */
describe('public api', () => {
  const VALID_CONFIGURATION = {
    applicationId: '00000000-aaaa-0000-aaaa-000000000000',
    clientToken: 'some_client_token',
    proxy: '/rum-intake/',
  }

  let payloads: string[]
  let originalXhr: typeof XMLHttpRequest
  let api: ReturnType<typeof makeRumLegacyPublicApi>

  /** The api as an untyped bag of methods, for the specs that iterate over the whole surface. */
  function anyApi(): { [method: string]: (...args: unknown[]) => unknown } {
    return api as unknown as { [method: string]: (...args: unknown[]) => unknown }
  }

  type SentEvent = { [key: string]: any }

  function sentEvents(): SentEvent[] {
    return payloads
      .join('\n')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as SentEvent)
  }

  function eventsOfType(type: string): SentEvent[] {
    return sentEvents().filter((event) => event.type === type)
  }

  function flush() {
    jasmine.clock().tick(FLUSH_TIMEOUT)
  }

  beforeEach(() => {
    // Unit builds keep this placeholder unreplaced, so each spec file has to provide it. Relying on
    // another spec file to set it makes the suite order dependent, and karma randomises the order.
    ;(window as unknown as BuildEnvWindow).__BUILD_ENV__SDK_VERSION__ = 'test-version'
    deleteSessionCookie()
    payloads = []
    jasmine.clock().install()
    originalXhr = window.XMLHttpRequest
    ;(window as any).XMLHttpRequest = function () {
      return {
        open: () => undefined,
        setRequestHeader: () => undefined,
        send: (body: string) => payloads.push(body),
      }
    }
    api = makeRumLegacyPublicApi()
  })

  afterEach(() => {
    anyApi()._stop()
    window.XMLHttpRequest = originalXhr
    jasmine.clock().uninstall()
    deleteSessionCookie()
  })

  describe('initialisation', () => {
    it('starts reporting once initialised', () => {
      api.init(VALID_CONFIGURATION)
      flush()

      expect(eventsOfType('view').length).toBeGreaterThan(0)
    })

    it('sends nothing before it is initialised', () => {
      api.addError(new Error('boom'))
      api.addAction('click')
      flush()

      expect(payloads).toEqual([])
    })

    it('hands out a copy of the configuration, not the object it keeps', () => {
      api.init({ ...VALID_CONFIGURATION, trackingConsent: 'not-granted' })

      const returned = api.getInitConfiguration() as Record<string, unknown>
      returned.applicationId = 'tampered'
      api.setTrackingConsent('granted')
      flush()

      // The stored configuration is what a later consent grant starts from, so handing out the live
      // object would let a caller change what the SDK reports as its application.
      expect(sentEvents()[0].application.id).toBe(VALID_CONFIGURATION.applicationId)
    })

    it('exposes the configuration it was initialised with', () => {
      api.init(VALID_CONFIGURATION)

      expect(api.getInitConfiguration()).toEqual(VALID_CONFIGURATION)
    })

    it('ignores a second initialisation instead of starting twice', () => {
      api.init(VALID_CONFIGURATION)
      flush()
      const afterFirst = eventsOfType('view').length

      api.init(VALID_CONFIGURATION)
      flush()

      expect(afterFirst).toBeGreaterThan(0)
      expect(eventsOfType('view').length).toBe(afterFirst)
    })

    for (const missing of ['applicationId', 'clientToken', 'proxy']) {
      it(`refuses to start without ${missing}, without throwing`, () => {
        const configuration: any = { ...VALID_CONFIGURATION }
        delete configuration[missing]

        expect(() => api.init(configuration)).not.toThrow()
        flush()
        expect(payloads).toEqual([])
      })
    }

    it('sends nothing for a session the sample rate excluded', () => {
      api.init({ ...VALID_CONFIGURATION, sessionSampleRate: 0 })
      api.addError(new Error('boom'))
      flush()

      expect(payloads).toEqual([])
    })

    it('reports the sample rate it was actually configured with', () => {
      api.init({ ...VALID_CONFIGURATION, sessionSampleRate: 100 })
      flush()

      expect(sentEvents()[0]._dd.configuration.session_sample_rate).toBe(100)
    })

    it('refuses a sample rate outside 0 to 100', () => {
      api.init({ ...VALID_CONFIGURATION, sessionSampleRate: 500 })
      flush()

      expect(payloads).toEqual([])
    })

    it('does not throw when called with nothing at all', () => {
      expect(() => anyApi().init()).not.toThrow()
    })
  })

  describe('tracking consent', () => {
    it('collects nothing when consent is withheld at init', () => {
      api.init({ ...VALID_CONFIGURATION, trackingConsent: 'not-granted' })
      api.addError(new Error('boom'))
      flush()

      expect(payloads).toEqual([])
    })

    it('collects when consent is granted at init', () => {
      api.init({ ...VALID_CONFIGURATION, trackingConsent: 'granted' })
      flush()

      expect(payloads.length).toBeGreaterThan(0)
    })

    it('defaults to granted when the option is absent', () => {
      api.init(VALID_CONFIGURATION)
      flush()

      expect(payloads.length).toBeGreaterThan(0)
    })

    it('starts collecting once consent is granted afterwards', () => {
      api.init({ ...VALID_CONFIGURATION, trackingConsent: 'not-granted' })

      api.setTrackingConsent('granted')
      api.addError(new Error('boom'))
      flush()

      const types = sentEvents().map((event) => event.type as string)
      expect(types).toContain('error')
    })

    it('stops collecting when consent is withdrawn', () => {
      api.init(VALID_CONFIGURATION)
      api.setTrackingConsent('not-granted')
      payloads = []

      api.addError(new Error('boom'))
      flush()

      expect(payloads).toEqual([])
    })

    it('does not send what was buffered before consent was withdrawn', () => {
      api.init(VALID_CONFIGURATION)
      api.addError(new Error('boom'))

      api.setTrackingConsent('not-granted')
      flush()

      expect(payloads).toEqual([])
    })

    it('clears the session when consent is withdrawn', () => {
      api.init(VALID_CONFIGURATION)
      expect(document.cookie).toContain('_dd_s=')

      api.setTrackingConsent('not-granted')

      expect(document.cookie).not.toContain('_dd_s=id')
    })

    it('treats an unrecognised value as consent not given, like the modern bundle does', () => {
      api.init({ ...VALID_CONFIGURATION, trackingConsent: 'granted' })
      payloads = []

      api.setTrackingConsent('yes-please' as any)
      api.addError(new Error('boom'))
      flush()

      expect(payloads).toEqual([])
    })
  })

  describe('reporting', () => {
    beforeEach(() => {
      api.init(VALID_CONFIGURATION)
    })

    it('reports a manually added error', () => {
      api.addError(new Error('boom'))
      flush()

      const errors = eventsOfType('error')
      expect(errors.length).toBe(1)
      expect(errors[0].error.message).toBe('boom')
      expect(errors[0].error.handling).toBe('handled')
    })

    it('reports an error only once', () => {
      api.addError(new Error('boom'))
      flush()

      expect(eventsOfType('error').length).toBe(1)
    })

    it('reports a custom action', () => {
      api.addAction('checkout')
      flush()

      const actions = eventsOfType('action')
      expect(actions.length).toBe(1)
      expect(actions[0].action.target.name).toBe('checkout')
      expect(actions[0].action.type).toBe('custom')
    })

    it('counts errors and actions into the view', () => {
      api.addError(new Error('boom'))
      api.addAction('checkout')
      api.startView('next')
      flush()

      const closedView = eventsOfType('view').filter((event) => event.view.is_active === false)[0]
      expect(closedView.view.error.count).toBe(1)
      expect(closedView.view.action.count).toBe(1)
    })

    it('hands out a copy of the global context, not the object it keeps', () => {
      api.setGlobalContext({ tenant: 'acme' })
      ;(api.getGlobalContext() as Record<string, unknown>).tenant = 'tampered'
      api.addError(new Error('boom'))
      flush()

      expect(eventsOfType('error')[0].context).toEqual({ tenant: 'acme' })
    })

    it('hands out a copy of the user, not the object it keeps', () => {
      api.setUser({ id: 'u-1' })
      ;(api.getUser() as Record<string, unknown>).id = 'tampered'
      api.addError(new Error('boom'))
      flush()

      expect(eventsOfType('error')[0].usr).toEqual({ id: 'u-1' })
    })

    it('attaches the global context to events', () => {
      api.setGlobalContext({ tenant: 'acme' })
      api.addError(new Error('boom'))
      flush()

      expect(eventsOfType('error')[0].context).toEqual({ tenant: 'acme' })
    })

    it('lets a per-event context extend the global one', () => {
      api.setGlobalContext({ tenant: 'acme' })
      api.addError(new Error('boom'), { orderId: 7 })
      flush()

      expect(eventsOfType('error')[0].context).toEqual({ tenant: 'acme', orderId: 7 })
    })

    it('attaches the user to events under the field the intake expects', () => {
      api.setUser({ id: 'u-1', name: 'Ada' })
      api.addError(new Error('boom'))
      flush()

      expect(eventsOfType('error')[0].usr).toEqual({ id: 'u-1', name: 'Ada' })
    })

    it('leaves out an account without an id, which the format would reject', () => {
      api.setAccount({ name: 'no id here' })
      api.addError(new Error('boom'))
      flush()

      expect('account' in eventsOfType('error')[0]).toBe(false)
    })

    it('keeps a stable session id across events', () => {
      api.addError(new Error('first'))
      api.addAction('checkout')
      flush()

      const ids = sentEvents().map((event) => event.session.id as string)
      expect(new Set(ids).size).toBe(1)
    })

    it('stops reporting after the session is stopped', () => {
      api.stopSession()
      payloads = []

      api.addError(new Error('boom'))
      flush()

      expect(payloads).toEqual([])
    })

    /*
     * Page exit handlers are captured rather than dispatched: the test runner installs its own
     * beforeunload/unload handlers to detect navigation, and firing real ones makes it believe the
     * page reloaded and abandon the run.
     */
    function captureExitHandlers() {
      const handlers: { [eventName: string]: Array<() => void> } = {}
      spyOn(window, 'addEventListener').and.callFake((eventName: string, handler: any) => {
        handlers[eventName] = handlers[eventName] || []
        handlers[eventName].push(handler)
      })
      return handlers
    }

    it('sends a closing view update when the page unloads', () => {
      const handlers = captureExitHandlers()
      const freshApi = makeRumLegacyPublicApi()
      freshApi.init(VALID_CONFIGURATION)
      payloads = []

      handlers.beforeunload[0]()

      const closing = eventsOfType('view').filter((event) => event.view.is_active === false)
      expect(closing.length).toBe(1)
      ;(freshApi as unknown as { _stop: () => void })._stop()
    })

    it('carries the time spent and the counts collected during the view into that update', () => {
      const handlers = captureExitHandlers()
      const freshApi = makeRumLegacyPublicApi()
      freshApi.init(VALID_CONFIGURATION)
      freshApi.addError(new Error('boom'))
      freshApi.addAction('checkout')
      // mockDate, not tick: the jasmine clock advances timers but leaves Date alone, and time spent
      // is measured from the wall clock.
      jasmine.clock().mockDate(new Date(Date.now() + 2000))
      payloads = []

      handlers.beforeunload[0]()

      const closing = eventsOfType('view').filter((event) => event.view.is_active === false)[0]
      expect(closing.view.error.count).toBe(1)
      expect(closing.view.action.count).toBe(1)
      expect(closing.view.time_spent).toBeGreaterThan(0)
      ;(freshApi as unknown as { _stop: () => void })._stop()
    })

    it('closes the view before sending, so the closing update is in the same request', () => {
      const handlers = captureExitHandlers()
      const freshApi = makeRumLegacyPublicApi()
      freshApi.init(VALID_CONFIGURATION)
      payloads = []

      handlers.beforeunload[0]()

      // A single request carrying the closing update. Flushing before closing the view would send
      // an empty buffer and lose it entirely.
      expect(payloads.length).toBe(1)
      ;(freshApi as unknown as { _stop: () => void })._stop()
    })

    it('sends everything through the exit transport, even a batch that fills up while closing', () => {
      const handlers = captureExitHandlers()
      const asyncPayloads: string[] = []
      const exitPayloads: string[] = []
      ;(window as any).XMLHttpRequest = function () {
        let isAsync = true
        return {
          open: (_m: string, _u: string, a: boolean) => (isAsync = a),
          setRequestHeader: () => undefined,
          send: (body: string) => (isAsync ? asyncPayloads : exitPayloads).push(body),
        }
      }
      const freshApi = makeRumLegacyPublicApi()
      freshApi.init(VALID_CONFIGURATION)
      // Every event now carries most of the byte budget, so the closing view update is the one that
      // tips the buffer over the limit while the page is already unloading.
      freshApi.setGlobalContext({ padding: new Array(Math.floor(BATCH_BYTES_LIMIT * 0.7)).join('a') })
      freshApi.addAction('checkout')
      asyncPayloads.length = 0

      handlers.beforeunload[0]()

      // An async request started while the page is unloading is not going to arrive.
      expect(asyncPayloads).toEqual([])
      expect(exitPayloads.length).toBeGreaterThan(0)
      ;(freshApi as unknown as { _stop: () => void })._stop()
    })

    it('does not block the closing page with a second synchronous request', () => {
      const handlers = captureExitHandlers()
      const freshApi = makeRumLegacyPublicApi()
      freshApi.init(VALID_CONFIGURATION)
      payloads = []

      handlers.beforeunload[0]()
      handlers.unload[0]()

      expect(payloads.length).toBe(1)
      ;(freshApi as unknown as { _stop: () => void })._stop()
    })

    it('sends to the configured proxy path', () => {
      let url = ''
      ;(window as any).XMLHttpRequest = function () {
        return {
          open: (_method: string, requestUrl: string) => (url = requestUrl),
          setRequestHeader: () => undefined,
          send: () => undefined,
        }
      }

      api.addError(new Error('boom'))
      flush()

      expect(url.indexOf(`${location.origin}/rum-intake/?ddforward=`)).toBe(0)
    })
  })

  describe('safety net', () => {
    /**
     * Replaces cookie access with a throwing one and puts the real descriptor back afterwards. A
     * jasmine spy would still be installed while this spec's teardown runs, which needs to write
     * the cookie.
     */
    function withThrowingCookieAccess(operation: () => void) {
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!
      Object.defineProperty(document, 'cookie', {
        get: () => '',
        set: () => {
          throw new Error('cookie access denied')
        },
        configurable: true,
      })
      try {
        operation()
      } finally {
        Object.defineProperty(document, 'cookie', descriptor)
      }
    }

    const NO_OP_METHODS = [
      'setTrackingConsent',
      'setViewContext',
      'setViewContextProperty',
      'getViewContext',
      'addTiming',
      'addFeatureFlagEvaluation',
      'getSessionReplayLink',
      'startSessionReplayRecording',
      'stopSessionReplayRecording',
      'addDurationVital',
      'startDurationVital',
      'stopDurationVital',
    ]

    const SUPPORTED_METHODS = [
      'init',
      'getInitConfiguration',
      'getInternalContext',
      'addError',
      'addAction',
      'startView',
      'setViewName',
      'setGlobalContext',
      'getGlobalContext',
      'setGlobalContextProperty',
      'removeGlobalContextProperty',
      'clearGlobalContext',
      'setUser',
      'getUser',
      'setUserProperty',
      'removeUserProperty',
      'clearUser',
      'setAccount',
      'getAccount',
      'setAccountProperty',
      'removeAccountProperty',
      'clearAccount',
      'stopSession',
    ]

    it('exposes every method a page written against the modern bundle may call', () => {
      // A missing method throws "undefined is not a function" and takes the page down, which is the
      // failure this build exists to prevent. Presence matters more than behaviour here.
      for (const method of NO_OP_METHODS.concat(SUPPORTED_METHODS).concat(['onReady'])) {
        expect(typeof anyApi()[method]).toBe('function', `${method} is missing`)
      }
    })

    it('survives every method being called before initialisation', () => {
      // onReady is excluded on purpose. It invokes the caller's own callback directly and must not
      // wrap it: swallowing there would hide the customer's exceptions rather than the SDK's. The
      // modern bundle leaves it unmonitored for the same reason.
      for (const method of NO_OP_METHODS.concat(SUPPORTED_METHODS)) {
        expect(() => anyApi()[method]('a', 'b')).not.toThrow()
      }
    })

    it('lets an exception from an onReady callback surface to the page', () => {
      expect(() =>
        api.onReady(() => {
          throw new Error('customer callback is broken')
        })
      ).toThrowError('customer callback is broken')
    })

    it('survives every method being called after initialisation', () => {
      api.init(VALID_CONFIGURATION)

      for (const method of NO_OP_METHODS) {
        expect(() => anyApi()[method]('a', 'b')).not.toThrow()
      }
    })

    it('reports its version', () => {
      expect(typeof api.version).toBe('string')
    })

    it('runs an onReady callback immediately, since the bundle has already loaded', () => {
      const callback = jasmine.createSpy('callback')

      api.onReady(callback)

      expect(callback).toHaveBeenCalled()
    })

    it('keeps working when the transport is completely broken', () => {
      ;(window as any).XMLHttpRequest = function () {
        throw new Error('blocked by the browser')
      }
      api.init(VALID_CONFIGURATION)

      expect(() => {
        api.addError(new Error('boom'))
        flush()
      }).not.toThrow()
    })

    it('does not let a failure escape through the page exit listener', () => {
      const handlers: { [eventName: string]: Array<() => void> } = {}
      spyOn(window, 'addEventListener').and.callFake((eventName: string, handler: any) => {
        handlers[eventName] = handlers[eventName] || []
        handlers[eventName].push(handler)
      })
      const freshApi = makeRumLegacyPublicApi()
      freshApi.init(VALID_CONFIGURATION)
      // Past the session cookie throttling window, so the exit really does touch the cookie.
      jasmine.clock().mockDate(new Date(Date.now() + COOKIE_ACCESS_DELAY + 1))

      // Some privacy modes throw on cookie access. The browser calls the exit listener directly, so
      // without a guard that failure would surface as an uncaught error while the page unloads.
      withThrowingCookieAccess(() => {
        expect(() => handlers.beforeunload[0]()).not.toThrow()
      })
      ;(freshApi as unknown as { _stop: () => void })._stop()
    })

    it('does not let a failure escape through a public method either', () => {
      api.init(VALID_CONFIGURATION)
      jasmine.clock().mockDate(new Date(Date.now() + COOKIE_ACCESS_DELAY + 1))

      withThrowingCookieAccess(() => {
        expect(() => api.addError(new Error('boom'))).not.toThrow()
      })
    })

    it('does not let a circular context break reporting', () => {
      api.init(VALID_CONFIGURATION)
      const circular: any = {}
      circular.self = circular

      expect(() => {
        api.setGlobalContext(circular)
        api.addError(new Error('boom'))
        flush()
      }).not.toThrow()
    })
  })
})
