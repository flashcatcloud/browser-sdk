import type { HttpRequest } from './httpRequest'
import { BATCH_BYTES_LIMIT, BATCH_MESSAGES_LIMIT, FLUSH_TIMEOUT, MESSAGE_BYTES_LIMIT, startBatch } from './batch'

describe('batch', () => {
  let request: HttpRequest & { sentPayloads: string[]; exitPayloads: string[] }

  function createRequestSpy() {
    const sentPayloads: string[] = []
    const exitPayloads: string[] = []
    return {
      sentPayloads,
      exitPayloads,
      send: (data: string) => sentPayloads.push(data),
      sendOnExit: (data: string) => exitPayloads.push(data),
    }
  }

  beforeEach(() => {
    request = createRequestSpy()
    jasmine.clock().install()
  })

  afterEach(() => {
    jasmine.clock().uninstall()
  })

  it('buffers events instead of sending one request per event', () => {
    const batch = startBatch(request)

    batch.add({ type: 'view' })
    batch.add({ type: 'error' })

    expect(request.sentPayloads).toEqual([])
    batch.stop()
  })

  it('sends one json document per line', () => {
    const batch = startBatch(request)

    batch.add({ type: 'view' })
    batch.add({ type: 'error' })
    batch.flush()

    expect(request.sentPayloads.length).toBe(1)
    expect(request.sentPayloads[0].split('\n')).toEqual(['{"type":"view"}', '{"type":"error"}'])
    batch.stop()
  })

  it('sends nothing when the buffer is empty', () => {
    const batch = startBatch(request)

    batch.flush()

    expect(request.sentPayloads).toEqual([])
    batch.stop()
  })

  it('flushes once the message count limit is reached', () => {
    const batch = startBatch(request)

    for (let i = 0; i < BATCH_MESSAGES_LIMIT; i++) {
      batch.add({ i })
    }

    expect(request.sentPayloads.length).toBe(1)
    expect(request.sentPayloads[0].split('\n').length).toBe(BATCH_MESSAGES_LIMIT)
    batch.stop()
  })

  it('flushes once the byte limit is reached', () => {
    const batch = startBatch(request)
    const padding = new Array(1024).join('a')

    let added = 0
    while (request.sentPayloads.length === 0) {
      batch.add({ padding })
      added++
      if (added > 1000) {
        break
      }
    }

    expect(request.sentPayloads.length).toBe(1)
    expect(request.sentPayloads[0].length).toBeLessThan(BATCH_BYTES_LIMIT * 2)
    batch.stop()
  })

  it('flushes on a timer so a quiet page still reports', () => {
    const batch = startBatch(request)

    batch.add({ type: 'view' })
    expect(request.sentPayloads).toEqual([])

    jasmine.clock().tick(FLUSH_TIMEOUT)

    expect(request.sentPayloads.length).toBe(1)
    batch.stop()
  })

  it('drops a single event too large to ever be accepted, keeping the rest of the batch', () => {
    const batch = startBatch(request)

    batch.add({ padding: new Array(MESSAGE_BYTES_LIMIT + 10).join('a') })
    batch.add({ type: 'view' })
    batch.flush()

    expect(request.sentPayloads).toEqual(['{"type":"view"}'])
    batch.stop()
  })

  it('drops an event that cannot be serialised rather than losing the batch', () => {
    const batch = startBatch(request)
    const circular: any = {}
    circular.self = circular

    expect(() => batch.add(circular)).not.toThrow()
    batch.add({ type: 'view' })
    batch.flush()

    expect(request.sentPayloads).toEqual(['{"type":"view"}'])
    batch.stop()
  })

  /**
   * The page exit events are captured rather than dispatched. The test runner installs its own
   * beforeunload/unload handlers to detect navigation, so firing real ones on window makes it
   * believe the page reloaded and abandons the run.
   */
  function captureExitHandlers() {
    const handlers: { [eventName: string]: Array<() => void> } = {}
    spyOn(window, 'addEventListener').and.callFake((eventName: string, handler: any) => {
      handlers[eventName] = handlers[eventName] || []
      handlers[eventName].push(handler)
    })
    return handlers
  }

  it('uses the exit transport when the page is unloading', () => {
    const handlers = captureExitHandlers()
    const batch = startBatch(request)

    batch.add({ type: 'view' })
    handlers.beforeunload[0]()

    expect(request.exitPayloads).toEqual(['{"type":"view"}'])
    expect(request.sentPayloads).toEqual([])
    batch.stop()
  })

  it('listens to both page exit events available before IE10', () => {
    const handlers = captureExitHandlers()

    const batch = startBatch(request)

    expect(handlers.beforeunload).toBeDefined()
    expect(handlers.unload).toBeDefined()
    batch.stop()
  })

  it('does not send the same events twice when both exit events fire', () => {
    const handlers = captureExitHandlers()
    const batch = startBatch(request)

    batch.add({ type: 'view' })
    handlers.beforeunload[0]()
    handlers.unload[0]()

    expect(request.exitPayloads).toEqual(['{"type":"view"}'])
    batch.stop()
  })

  it('stops listening and stops flushing once stopped', () => {
    const handlers = captureExitHandlers()
    const batch = startBatch(request)
    batch.stop()

    batch.add({ type: 'view' })
    jasmine.clock().tick(FLUSH_TIMEOUT * 2)
    handlers.beforeunload[0]()

    expect(request.sentPayloads).toEqual([])
    expect(request.exitPayloads).toEqual([])
  })
})
