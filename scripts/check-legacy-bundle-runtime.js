'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { printLog, printError, runMain } = require('./lib/executionUtils')

const BUNDLE_PATH = path.join(__dirname, '..', 'packages/rum-legacy/bundle/fc-rum-legacy.js')

/**
 * Smoke test for the emitted bundle rather than for its sources.
 *
 * Every unit spec runs against TypeScript compiled by the test runner, not against the file
 * customers actually load. Between the two sit Terser and the webpack runtime, so a mangled
 * property, a dropped assignment or an emitted helper that the target browsers lack would pass the
 * whole suite and only fail once the file is served.
 *
 * The environment below is deliberately impoverished: no fetch, no Promise, no sendBeacon, and an
 * XMLHttpRequest that only fires onreadystatechange, the way IE9 behaves. Anything the bundle
 * reaches for that is not defined here throws, which is the point.
 */
runMain(() => {
  if (!fs.existsSync(BUNDLE_PATH)) {
    printError('Bundle not found, build it before running this check')
    process.exit(1)
  }

  const requests = []
  const context = createBrowserLikeContext(requests)

  vm.createContext(context)
  vm.runInContext(fs.readFileSync(BUNDLE_PATH, 'utf-8'), context, { filename: 'fc-rum-legacy.js' })

  const failures = []
  const api = context.window.FC_RUM

  if (!api || typeof api.init !== 'function') {
    printError('The bundle did not expose FC_RUM.init')
    process.exit(1)
  }

  api.init({
    applicationId: '00000000-aaaa-0000-aaaa-000000000000',
    clientToken: 'a_client_token',
    proxy: '/rum-intake/',
  })
  api.addError(new Error('smoke'))

  // Closing the page is what flushes without waiting for the timer.
  context.window.__fireEvent('beforeunload')

  if (requests.length === 0) {
    failures.push('the bundle sent nothing')
  } else {
    const request = requests[0]
    if (request.method !== 'POST') {
      failures.push(`expected a POST, got ${request.method}`)
    }
    if (request.url.indexOf('https://app.example.com/rum-intake/?ddforward=') !== 0) {
      failures.push(`unexpected intake url: ${request.url}`)
    }

    // The property the whole deployment rests on: the real intake path and its parameters travel
    // inside ddforward, so a reverse proxy rule written for the standard bundles also serves this
    // one. Checking only the prefix above would miss a change to either.
    const forwarded = decodeURIComponent(request.url.split('?ddforward=')[1] || '')
    const [forwardedPath, forwardedQuery] = forwarded.split('?')
    if (forwardedPath !== '/api/v2/rum') {
      failures.push(`unexpected forwarded intake path: ${forwardedPath}`)
    }
    const parameterNames = (forwardedQuery || '').split('&').map((entry) => entry.split('=')[0])
    const expectedParameters = [
      'ddsource',
      'ddtags',
      'dd-api-key',
      'dd-evp-origin-version',
      'dd-evp-origin',
      'dd-request-id',
      'batch_time',
    ]
    if (parameterNames.join(',') !== expectedParameters.join(',')) {
      failures.push(`unexpected intake parameters: ${parameterNames.join(',')}`)
    }
    if (request.async !== false) {
      failures.push('the exit request was not synchronous')
    }
    const events = request.body.split('\n').map((line) => JSON.parse(line))
    const types = events.map((event) => event.type)
    for (const expected of ['view', 'error']) {
      if (types.indexOf(expected) === -1) {
        failures.push(`no ${expected} event in the payload, got: ${types.join(', ')}`)
      }
    }
    const error = events.filter((event) => event.type === 'error')[0]
    if (error && error.error.message !== 'smoke') {
      failures.push(`unexpected error message: ${error.error.message}`)
    }
    if (error && !error.session.id) {
      failures.push('the payload carries no session id')
    }
  }

  if (failures.length > 0) {
    printError('Legacy bundle runtime check failed:')
    for (const failure of failures) {
      printError(`  - ${failure}`)
    }
    process.exit(1)
  }

  printLog('✅ the emitted bundle initialises and reports in a browser without the modern APIs')
})

function createBrowserLikeContext(requests) {
  const listeners = {}
  let cookie = ''

  function XMLHttpRequestStub() {
    const request = { async: true }
    this.open = function (method, url, isAsync) {
      request.method = method
      request.url = url
      request.async = isAsync
    }
    this.send = function (body) {
      request.body = body
      requests.push(request)
      this.readyState = 4
      this.status = 202
      if (this.onreadystatechange) {
        this.onreadystatechange()
      }
    }
    // Deliberately no onload: IE10 introduced it.
  }

  const window = {
    location: { href: 'https://app.example.com/checkout', origin: 'https://app.example.com' },
    XMLHttpRequest: XMLHttpRequestStub,
    navigator: { userAgent: 'IE9-like' },
    addEventListener(eventName, handler) {
      listeners[eventName] = listeners[eventName] || []
      listeners[eventName].push(handler)
    },
    removeEventListener(eventName, handler) {
      const registered = listeners[eventName] || []
      const index = registered.indexOf(handler)
      if (index !== -1) {
        registered.splice(index, 1)
      }
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    __fireEvent(eventName) {
      for (const handler of listeners[eventName] || []) {
        handler()
      }
    },
  }

  window.window = window
  window.self = window

  window.document = {
    readyState: 'complete',
    referrer: 'https://search.example.com/',
    get cookie() {
      return cookie
    },
    set cookie(value) {
      cookie = value.split(';')[0]
    },
    createElement: (tagName) => {
      if (tagName !== 'a') {
        throw new Error(`unexpected element requested: ${tagName}`)
      }
      // Resolves a relative url against the document, which is what the anchor trick does.
      const anchor = { _href: '' }
      Object.defineProperty(anchor, 'href', {
        get: () => anchor._href,
        set: (value) => {
          anchor._href = value.indexOf('http') === 0 ? value : `${window.location.origin}${value}`
        },
      })
      return anchor
    },
    getElementsByTagName: () => [],
  }

  window.performance = {
    timing: {
      navigationStart: 1_000_000,
      responseStart: 1_000_100,
      domInteractive: 1_000_200,
      domContentLoadedEventEnd: 1_000_300,
      domComplete: 1_000_400,
      loadEventEnd: 1_000_500,
    },
  }

  return window
}
