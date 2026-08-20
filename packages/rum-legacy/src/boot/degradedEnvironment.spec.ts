import type { BuildEnvWindow } from '../../../core/test'
import { deleteSessionCookie } from '../domain/sessionStore'
import { FLUSH_TIMEOUT } from '../transport/batch'
import { makeRumLegacyPublicApi } from './publicApi'

/*
 * The closest approximation to the target browsers that a modern test runner allows.
 *
 * Every other spec runs in a browser that has fetch, Promise, sendBeacon and the observers, so a
 * dependency on any of them would pass the whole suite and fail only on the browsers this package
 * exists for. Here they are taken away for the duration of the call, which is safe because
 * everything this package does is synchronous.
 *
 * Only APIs that could slip past the compiler are removed. The ES2015 collections (Map, Set,
 * Symbol, WeakMap) are deliberately left in place: `lib: ES5` already makes using them a compile
 * error, which is a stronger guarantee than a runtime spec, and check-es5-compatibility.js scans
 * the emitted bundle for them. Removing them here would only break the suite's own
 * instrumentation, since the shared leak detector wraps addEventListener in a function that
 * constructs a Map, and the first listener this package registers would then fail inside the test
 * harness rather than inside the code under test.
 *
 * None of this emulates an old JavaScript engine. It catches missing runtime APIs, not syntax or
 * engine quirks; the ES5 parse gate covers syntax, and neither covers real IE behaviour.
 */
const REMOVED_GLOBALS = ['fetch', 'Promise', 'MutationObserver', 'PerformanceObserver', 'TextEncoder', 'URL'] as const

/** Absent entirely, not merely undefined — see `remove` below for why the difference matters. */
const DELETED_GLOBALS = ['performance'] as const

/*
 * These globals are shared with every other spec in the suite, which all run in the same browser
 * context. Restoring them by plain assignment is not enough: `navigator.sendBeacon` lives on
 * Navigator.prototype, so hiding it creates an own property on the instance, and assigning the
 * function back leaves that own property in place. The shape has changed even though the value
 * looks right, and specs elsewhere that spy on or feature-detect it then behave differently.
 *
 * So the original property descriptor is captured and put back exactly, and a global that had no
 * own property has its shadow deleted rather than overwritten.
 */
function withIE9Environment<T>(operation: () => T): T {
  const hidden: Array<{ host: any; name: string; descriptor: PropertyDescriptor | undefined }> = []

  function hide(host: any, name: string) {
    hidden.push({ host, name, descriptor: Object.getOwnPropertyDescriptor(host, name) })
    Object.defineProperty(host, name, { value: undefined, configurable: true, writable: true })
  }

  /*
   * Deleted outright rather than defined as undefined. The two are not the same to a bare
   * identifier reference: an own property holding undefined resolves quietly, while an absent one
   * throws a ReferenceError. Engines that never shipped an API are the second case, so hiding it
   * the first way would leave exactly the code this suite exists to catch passing.
   */
  function remove(host: any, name: string) {
    hidden.push({ host, name, descriptor: Object.getOwnPropertyDescriptor(host, name) })
    delete host[name]
  }

  for (const name of REMOVED_GLOBALS) {
    hide(window, name)
  }
  for (const name of DELETED_GLOBALS) {
    remove(window, name)
  }
  hide(navigator, 'sendBeacon')

  try {
    return operation()
  } finally {
    for (const { host, name, descriptor } of hidden.reverse()) {
      if (descriptor) {
        Object.defineProperty(host, name, descriptor)
      } else {
        // It was inherited: removing the shadow makes the prototype's version visible again.
        delete host[name]
      }
    }
  }
}

describe('degraded environment', () => {
  const VALID_CONFIGURATION = {
    applicationId: '00000000-aaaa-0000-aaaa-000000000000',
    clientToken: 'some_client_token',
    proxy: '/rum-intake/',
  }

  let payloads: string[]
  let headers: Array<[string, string]>
  let requests: Array<{ method?: string; url?: string; async?: boolean }>
  let originalXhr: typeof XMLHttpRequest
  let api: ReturnType<typeof makeRumLegacyPublicApi> | undefined

  beforeEach(() => {
    ;(window as unknown as BuildEnvWindow).__BUILD_ENV__SDK_VERSION__ = 'test-version'
    payloads = []
    headers = []
    requests = []
    jasmine.clock().install()
    originalXhr = window.XMLHttpRequest
    ;(window as any).XMLHttpRequest = function () {
      // No onload, no onerror, no onprogress: this is what IE9 offers.
      const request: { [key: string]: unknown } = {
        readyState: 0,
        status: 0,
        open(method: string, url: string, isAsync: boolean) {
          requests.push({ method, url, async: isAsync })
        },
        send(body: string) {
          payloads.push(body)
        },
        setRequestHeader(name: string, value: string) {
          headers.push([name, value])
        },
      }
      return request
    }
  })

  afterEach(() => {
    ;(api as unknown as { _stop: () => void } | undefined)?._stop()
    api = undefined
    window.XMLHttpRequest = originalXhr
    jasmine.clock().uninstall()
    deleteSessionCookie()
  })

  function events(): Array<{ [key: string]: any }> {
    return payloads
      .join('\n')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { [key: string]: any })
  }

  it('initialises without any of the modern APIs present', () => {
    withIE9Environment(() => {
      api = makeRumLegacyPublicApi()
      api.init(VALID_CONFIGURATION)
    })
    jasmine.clock().tick(FLUSH_TIMEOUT)

    expect(events().length).toBeGreaterThan(0)
  })

  it('reports errors and actions without any of the modern APIs present', () => {
    withIE9Environment(() => {
      api = makeRumLegacyPublicApi()
      api.init(VALID_CONFIGURATION)
      api.addError(new Error('boom'))
      api.addAction('checkout')
    })
    jasmine.clock().tick(FLUSH_TIMEOUT)

    const types = events().map((event) => event.type as string)
    expect(types).toContain('error')
    expect(types).toContain('action')
    expect(types).toContain('view')
  })

  it('sends over XMLHttpRequest with the content type the intake requires', () => {
    withIE9Environment(() => {
      api = makeRumLegacyPublicApi()
      api.init(VALID_CONFIGURATION)
      api.addError(new Error('boom'))
    })
    jasmine.clock().tick(FLUSH_TIMEOUT)

    expect(requests.length).toBeGreaterThan(0)
    expect(requests[0].method).toBe('POST')
    expect(requests[0].async).toBe(true)
    expect(headers).toEqual([['Content-Type', 'text/plain;charset=UTF-8']])
  })

  it('still produces a valid session cookie', () => {
    withIE9Environment(() => {
      api = makeRumLegacyPublicApi()
      api.init(VALID_CONFIGURATION)
    })
    jasmine.clock().tick(FLUSH_TIMEOUT)

    expect(document.cookie).toContain('_dd_s=')
    expect(events()[0].session.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('measures payload size without TextEncoder', () => {
    withIE9Environment(() => {
      api = makeRumLegacyPublicApi()
      api.init(VALID_CONFIGURATION)
      // Non-latin content is where a string-length approximation would go wrong.
      api.setGlobalContext({ note: '订单支付失败'.repeat(50) })
      api.addError(new Error('boom'))
    })
    jasmine.clock().tick(FLUSH_TIMEOUT)

    expect(events().length).toBeGreaterThan(0)
  })

  it('resolves a relative proxy path without the URL constructor', () => {
    withIE9Environment(() => {
      api = makeRumLegacyPublicApi()
      api.init(VALID_CONFIGURATION)
      api.addError(new Error('boom'))
    })
    jasmine.clock().tick(FLUSH_TIMEOUT)

    expect(requests[0].url!.indexOf(`${location.origin}/rum-intake/?ddforward=`)).toBe(0)
  })

  it('never throws out of the public api when the environment is this bare', () => {
    expect(() =>
      withIE9Environment(() => {
        api = makeRumLegacyPublicApi()
        api.init(VALID_CONFIGURATION)
        api.setUser({ id: 'u-1' })
        api.setGlobalContext({ tenant: 'acme' })
        api.startView('checkout')
        api.addError('a string error')
        api.addAction('click')
        api.startSessionReplayRecording()
        api.addDurationVital()
        api.stopSession()
      })
    ).not.toThrow()
  })
})
