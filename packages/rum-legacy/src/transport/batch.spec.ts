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

  it('uses the exit transport when asked to flush on exit', () => {
    const batch = startBatch(request)

    batch.add({ type: 'view' })
    batch.flushOnExit()

    expect(request.exitPayloads).toEqual(['{"type":"view"}'])
    expect(request.sentPayloads).toEqual([])
    batch.stop()
  })

  it('does not register its own page exit listener', () => {
    // Page exit is owned by the caller, which has to close the current view before the buffer is
    // sent. A listener here would run first and flush an empty buffer.
    const addEventListenerSpy = spyOn(window, 'addEventListener').and.callThrough()

    const batch = startBatch(request)

    const registered = addEventListenerSpy.calls.allArgs().map(([eventName]) => eventName)
    expect(registered).not.toContain('beforeunload')
    expect(registered).not.toContain('unload')
    batch.stop()
  })

  it('sends nothing on exit when the buffer is empty', () => {
    const batch = startBatch(request)

    batch.flushOnExit()

    expect(request.exitPayloads).toEqual([])
    batch.stop()
  })

  it('stops buffering and stops flushing once stopped', () => {
    const batch = startBatch(request)
    batch.stop()

    batch.add({ type: 'view' })
    jasmine.clock().tick(FLUSH_TIMEOUT * 2)
    batch.flush()
    batch.flushOnExit()

    expect(request.sentPayloads).toEqual([])
    expect(request.exitPayloads).toEqual([])
  })
})
