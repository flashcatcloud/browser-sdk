import type { Duration, Payload, RelativeTime } from '@flashcatcloud/browser-core'
import { RequestType } from '@flashcatcloud/browser-core'
import type { MockFetch, MockFetchManager } from '@flashcatcloud/browser-core/test'
import { registerCleanupTask, SPEC_ENDPOINTS, mockFetch, mockXhr, withXhr } from '@flashcatcloud/browser-core/test'
import { createPerformanceEntry, mockGlobalPerformanceBuffer, mockRumConfiguration } from '../../test'
import { RumPerformanceEntryType } from '../browser/performanceObservable'
import { LifeCycle, LifeCycleEventType } from './lifeCycle'
import type { RequestCompleteEvent, RequestStartEvent } from './requestCollection'
import { trackFetch, trackXhr } from './requestCollection'
import type { Tracer } from './tracing/tracer'
import { clearTracingIfNeeded } from './tracing/tracer'
import { createSpanIdentifier, createTraceIdentifier } from './tracing/identifier'
import { matchRequestResourceEntry } from './resource/matchRequestResourceEntry'

const DEFAULT_PAYLOAD = {} as Payload
const CLOCK_DRIFT = 3

/**
 * Makes the monotonic clock (`performance.now()`) run ahead of the system clock (`Date`), as it
 * does when the system clock is slewed or adjusted while a request is in flight.
 */
function mockMonotonicClockDrift() {
  const originalNow = performance.now.bind(performance)
  let offset = 0
  spyOn(performance, 'now').and.callFake(() => originalNow() + offset)
  return {
    drift: () => {
      offset += CLOCK_DRIFT
    },
  }
}

function createResourceEntry(name: string, startTime: RelativeTime, responseEnd: RelativeTime) {
  return createPerformanceEntry(RumPerformanceEntryType.RESOURCE, {
    name,
    startTime,
    duration: (responseEnd - startTime) as Duration,
    fetchStart: startTime,
    domainLookupStart: startTime,
    domainLookupEnd: startTime,
    connectStart: startTime,
    connectEnd: startTime,
    requestStart: startTime,
    responseStart: startTime,
    responseEnd,
    redirectStart: 0 as RelativeTime,
    redirectEnd: 0 as RelativeTime,
  })
}

describe('collect fetch', () => {
  const FAKE_URL = 'http://fake-url/'
  let fetch: MockFetch
  let mockFetchManager: MockFetchManager
  let startSpy: jasmine.Spy<(requestStartEvent: RequestStartEvent) => void>
  let completeSpy: jasmine.Spy<(requestCompleteEvent: RequestCompleteEvent) => void>
  let stopFetchTracking: () => void

  beforeEach(() => {
    mockFetchManager = mockFetch()

    startSpy = jasmine.createSpy('requestStart')
    completeSpy = jasmine.createSpy('requestComplete')
    const lifeCycle = new LifeCycle()
    lifeCycle.subscribe(LifeCycleEventType.REQUEST_STARTED, startSpy)
    lifeCycle.subscribe(LifeCycleEventType.REQUEST_COMPLETED, completeSpy)
    const tracerStub: Partial<Tracer> = {
      clearTracingIfNeeded,
      traceFetch: (context) => {
        context.traceId = createTraceIdentifier()
        context.spanId = createSpanIdentifier()
      },
    }
    ;({ stop: stopFetchTracking } = trackFetch(lifeCycle, tracerStub as Tracer))

    fetch = window.fetch as MockFetch

    registerCleanupTask(() => {
      stopFetchTracking()
    })
  })

  it('should notify on request start', (done) => {
    fetch(FAKE_URL).resolveWith({ status: 500, responseText: 'fetch error' })

    mockFetchManager.whenAllComplete(() => {
      expect(startSpy).toHaveBeenCalledWith({ requestIndex: jasmine.any(Number) as unknown as number, url: FAKE_URL })
      done()
    })
  })

  it('should notify on request without body', (done) => {
    fetch(FAKE_URL).resolveWith({ status: 200 })

    mockFetchManager.whenAllComplete(() => {
      const request = completeSpy.calls.argsFor(0)[0]

      expect(request.type).toEqual(RequestType.FETCH)
      expect(request.method).toEqual('GET')
      expect(request.url).toEqual(FAKE_URL)
      expect(request.status).toEqual(200)
      expect(request.handlingStack).toBeDefined()
      done()
    })
  })

  it('should notify on request with body used by another instrumentation', (done) => {
    fetch(FAKE_URL).resolveWith({ status: 200, bodyUsed: true })

    mockFetchManager.whenAllComplete(() => {
      const request = completeSpy.calls.argsFor(0)[0]

      expect(request.type).toEqual(RequestType.FETCH)
      expect(request.method).toEqual('GET')
      expect(request.url).toEqual(FAKE_URL)
      expect(request.status).toEqual(200)
      expect(request.handlingStack).toBeDefined()
      done()
    })
  })

  it('should notify on request with body disturbed', (done) => {
    fetch(FAKE_URL).resolveWith({ status: 200, bodyDisturbed: true })

    mockFetchManager.whenAllComplete(() => {
      const request = completeSpy.calls.argsFor(0)[0]

      expect(request.type).toEqual(RequestType.FETCH)
      expect(request.method).toEqual('GET')
      expect(request.url).toEqual(FAKE_URL)
      expect(request.status).toEqual(200)
      expect(request.handlingStack).toBeDefined()
      done()
    })
  })

  it('should notify on request complete', (done) => {
    fetch(FAKE_URL).resolveWith({ status: 500, responseText: 'fetch error' })

    mockFetchManager.whenAllComplete(() => {
      const request = completeSpy.calls.argsFor(0)[0]

      expect(request.type).toEqual(RequestType.FETCH)
      expect(request.method).toEqual('GET')
      expect(request.url).toEqual(FAKE_URL)
      expect(request.status).toEqual(500)
      expect(request.handlingStack).toBeDefined()
      done()
    })
  })

  it('should assign a request id', (done) => {
    fetch(FAKE_URL).resolveWith({ status: 500, responseText: 'fetch error' })

    mockFetchManager.whenAllComplete(() => {
      const startRequestIndex = startSpy.calls.argsFor(0)[0].requestIndex
      const completeRequestIndex = completeSpy.calls.argsFor(0)[0].requestIndex

      expect(completeRequestIndex).toBe(startRequestIndex)
      done()
    })
  })

  it('should ignore intake requests', (done) => {
    fetch(SPEC_ENDPOINTS.rumEndpointBuilder.build('fetch', DEFAULT_PAYLOAD)).resolveWith({
      status: 200,
      responseText: 'foo',
    })

    mockFetchManager.whenAllComplete(() => {
      expect(startSpy).not.toHaveBeenCalled()
      expect(completeSpy).not.toHaveBeenCalled()
      done()
    })
  })

  it('should keep the resource timing matchable when the system clock drifts during the request', (done) => {
    const clockDrift = mockMonotonicClockDrift()
    const performanceBuffer = mockGlobalPerformanceBuffer()

    const pendingFetch = fetch(FAKE_URL)
    clockDrift.drift()
    const responseEnd = performance.now() as RelativeTime
    pendingFetch.resolveWith({ status: 200, responseText: 'ok' })

    mockFetchManager.whenAllComplete(() => {
      const request = completeSpy.calls.argsFor(0)[0]
      performanceBuffer.addPerformanceEntry(createResourceEntry(FAKE_URL, request.startClocks.relative, responseEnd))

      expect(matchRequestResourceEntry(request)).toBeDefined()
      done()
    })
  })

  describe('tracing', () => {
    it('should trace requests by default', (done) => {
      fetch(FAKE_URL).resolveWith({ status: 200, responseText: 'ok' })

      mockFetchManager.whenAllComplete(() => {
        const request = completeSpy.calls.argsFor(0)[0]

        expect(request.traceId).toBeDefined()
        done()
      })
    })

    it('should trace aborted requests', (done) => {
      fetch(FAKE_URL).abort()

      mockFetchManager.whenAllComplete(() => {
        const request = completeSpy.calls.argsFor(0)[0]

        expect(request.traceId).toBeDefined()
        done()
      })
    })

    it('should not trace requests ending with status 0', (done) => {
      fetch(FAKE_URL).resolveWith({ status: 0, responseText: 'fetch cancelled' })

      mockFetchManager.whenAllComplete(() => {
        const request = completeSpy.calls.argsFor(0)[0]

        expect(request.status).toEqual(0)
        expect(request.traceId).toBeUndefined()
        done()
      })
    })
  })
})

describe('collect xhr', () => {
  let startSpy: jasmine.Spy<(requestStartEvent: RequestStartEvent) => void>
  let completeSpy: jasmine.Spy<(requestCompleteEvent: RequestCompleteEvent) => void>
  let stopXhrTracking: () => void

  beforeEach(() => {
    const configuration = mockRumConfiguration({ batchMessagesLimit: 1 })
    mockXhr()
    startSpy = jasmine.createSpy('requestStart')
    completeSpy = jasmine.createSpy('requestComplete')
    const lifeCycle = new LifeCycle()
    lifeCycle.subscribe(LifeCycleEventType.REQUEST_STARTED, startSpy)
    lifeCycle.subscribe(LifeCycleEventType.REQUEST_COMPLETED, completeSpy)
    const tracerStub: Partial<Tracer> = {
      clearTracingIfNeeded,
      traceXhr: (context) => {
        context.traceId = createTraceIdentifier()
        context.spanId = createSpanIdentifier()
      },
    }
    ;({ stop: stopXhrTracking } = trackXhr(lifeCycle, configuration, tracerStub as Tracer))

    registerCleanupTask(() => {
      stopXhrTracking()
    })
  })

  it('should notify on request start', (done) => {
    withXhr({
      setup(xhr) {
        xhr.open('GET', '/ok')
        xhr.send()
        xhr.complete(200)
      },
      onComplete() {
        expect(startSpy).toHaveBeenCalledWith({
          requestIndex: jasmine.any(Number) as unknown as number,
          url: jasmine.stringMatching(/\/ok$/) as unknown as string,
        })
        done()
      },
    })
  })

  it('should notify on request complete', (done) => {
    withXhr({
      setup(xhr) {
        xhr.open('GET', '/ok')
        xhr.send()
        xhr.complete(200, 'ok')
      },
      onComplete() {
        const request = completeSpy.calls.argsFor(0)[0]

        expect(request.type).toEqual(RequestType.XHR)
        expect(request.method).toEqual('GET')
        expect(request.url).toContain('/ok')
        expect(request.status).toEqual(200)
        expect(request.handlingStack).toBeDefined()
        done()
      },
    })
  })

  it('should assign a request id', (done) => {
    withXhr({
      setup(xhr) {
        xhr.open('GET', '/ok')
        xhr.send()
        xhr.complete(200)
      },
      onComplete() {
        const startRequestIndex = startSpy.calls.argsFor(0)[0].requestIndex
        const completeRequestIndex = completeSpy.calls.argsFor(0)[0].requestIndex

        expect(completeRequestIndex).toBe(startRequestIndex)
        done()
      },
    })
  })

  it('should ignore intake requests', (done) => {
    withXhr({
      setup(xhr) {
        xhr.open('GET', SPEC_ENDPOINTS.rumEndpointBuilder.build('fetch', DEFAULT_PAYLOAD))
        xhr.send()
        xhr.complete(200)
      },
      onComplete() {
        expect(startSpy).not.toHaveBeenCalled()
        expect(completeSpy).not.toHaveBeenCalled()
        done()
      },
    })
  })

  it('should not trace cancelled requests', (done) => {
    withXhr({
      setup(xhr) {
        xhr.open('GET', '/ok')
        xhr.send()
        xhr.complete(0)
      },
      onComplete() {
        const request = completeSpy.calls.argsFor(0)[0]
        expect(request.status).toEqual(0)
        expect(request.traceId).toEqual(undefined)
        done()
      },
    })
  })

  it('should keep the resource timing matchable when the system clock drifts during the request', (done) => {
    const clockDrift = mockMonotonicClockDrift()
    const performanceBuffer = mockGlobalPerformanceBuffer()
    let responseEnd: RelativeTime

    withXhr({
      setup(xhr) {
        xhr.open('GET', '/ok')
        xhr.send()
        clockDrift.drift()
        responseEnd = performance.now() as RelativeTime
        xhr.complete(200, 'ok')
      },
      onComplete() {
        const request = completeSpy.calls.argsFor(0)[0]
        performanceBuffer.addPerformanceEntry(
          createResourceEntry(request.url, request.startClocks.relative, responseEnd)
        )

        expect(matchRequestResourceEntry(request)).toBeDefined()
        done()
      },
    })
  })

  describe('tracing', () => {
    it('should trace requests by default', (done) => {
      withXhr({
        setup(xhr) {
          xhr.open('GET', '/ok')
          xhr.send()
          xhr.complete(200)
        },
        onComplete() {
          const request = completeSpy.calls.argsFor(0)[0]
          expect(request.traceId).toBeDefined()
          done()
        },
      })
    })

    it('should trace aborted requests', (done) => {
      withXhr({
        setup(xhr) {
          xhr.open('GET', '/ok')
          xhr.send()
          xhr.abort()
        },
        onComplete() {
          const request = completeSpy.calls.argsFor(0)[0]
          expect(request.traceId).toBeDefined()
          done()
        },
      })
    })

    it('should not trace requests ending with status 0', (done) => {
      withXhr({
        setup(xhr) {
          xhr.open('GET', '/ok')
          xhr.send()
          xhr.complete(0)
        },
        onComplete() {
          const request = completeSpy.calls.argsFor(0)[0]
          expect(request.status).toEqual(0)
          expect(request.traceId).toBeUndefined()
          done()
        },
      })
    })
  })
})
