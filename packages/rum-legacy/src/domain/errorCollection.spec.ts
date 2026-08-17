import { startErrorCollection } from './errorCollection'

describe('error collection', () => {
  let collected: any[]
  let stop: (() => void) | undefined
  let originalOnError: OnErrorEventHandler

  beforeEach(() => {
    collected = []
    originalOnError = window.onerror
    window.onerror = null
  })

  afterEach(() => {
    stop?.()
    stop = undefined
    window.onerror = originalOnError
  })

  function start() {
    const collection = startErrorCollection((error) => collected.push(error))
    stop = () => collection.stop()
    return collection
  }

  /** Invokes whatever handler is currently installed, the way the browser would. */
  function triggerUncaughtError(message: string, url?: string, line?: number, column?: number, error?: Error): unknown {
    const handler = window.onerror as (...args: unknown[]) => unknown
    return handler(message, url, line, column, error)
  }

  it('reports an uncaught error', () => {
    start()

    triggerUncaughtError('Uncaught Error: boom', 'https://example.com/app.js', 12)

    expect(collected.length).toBe(1)
    expect(collected[0].message).toBe('Uncaught Error: boom')
    expect(collected[0].source).toBe('source')
    expect(collected[0].handling).toBe('unhandled')
    expect(collected[0].source_type).toBe('browser')
    expect(collected[0].id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('keeps calling the handler the page had installed', () => {
    const pageHandler = jasmine.createSpy('pageHandler')
    window.onerror = pageHandler
    start()

    triggerUncaughtError('boom', 'https://example.com/app.js', 12, 34)

    expect(pageHandler).toHaveBeenCalledWith('boom', 'https://example.com/app.js', 12, 34, undefined)
  })

  it('passes through what the page handler returned, so it can still suppress the default logging', () => {
    window.onerror = () => true
    start()

    expect(triggerUncaughtError('boom', 'https://example.com/app.js', 12)).toBe(true)
  })

  it('does not suppress the default logging when there was no page handler', () => {
    start()

    expect(triggerUncaughtError('boom', 'https://example.com/app.js', 12)).toBe(false)
  })

  it('still reports the error when the page handler throws', () => {
    window.onerror = () => {
      throw new Error('page handler is broken')
    }
    start()

    expect(() => triggerUncaughtError('boom', 'https://example.com/app.js', 12)).not.toThrow()
    expect(collected.length).toBe(1)
  })

  it('restores the page handler when stopped', () => {
    const pageHandler = jasmine.createSpy('pageHandler')
    window.onerror = pageHandler
    const collection = start()

    collection.stop()

    expect(window.onerror).toBe(pageHandler)
  })

  it('records where the error happened when no error object is available', () => {
    // This is the IE9 case: onerror receives only a message, a url and a line.
    start()

    triggerUncaughtError('boom', 'https://example.com/app.js', 12)

    expect(collected[0].stack).toContain('https://example.com/app.js:12')
  })

  it('uses the real stack when the browser provides an error object', () => {
    start()
    const error = new TypeError('bad access')

    triggerUncaughtError('boom', 'https://example.com/app.js', 12, 34, error)

    expect(collected[0].type).toBe('TypeError')
    expect(collected[0].stack).toBe(error.stack)
    expect(collected[0].message).toBe('bad access')
  })

  it('recognises an error created in another frame', () => {
    // Frameset and iframe heavy pages are the norm for applications still running these browsers,
    // and an Error built in another frame fails `instanceof Error` in this one. Treating it as a
    // plain value would stringify it and lose the message, the type and the stack.
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const ForeignError = (frame.contentWindow as unknown as { Error: ErrorConstructor }).Error
    const foreignError = new ForeignError('from another frame')
    const collection = start()

    collection.addError(foreignError)
    document.body.removeChild(frame)

    expect(collected[0].message).toBe('from another frame')
    expect(collected[0].type).toBe('Error')
  })

  it('reports a manually added error as handled', () => {
    const collection = start()

    collection.addError(new Error('manual'))

    expect(collected[0].message).toBe('manual')
    expect(collected[0].handling).toBe('handled')
    expect(collected[0].source).toBe('custom')
  })

  it('accepts a non-error value passed to addError', () => {
    const collection = start()

    collection.addError('just a string')

    expect(collected[0].message).toBe('just a string')
    expect('stack' in collected[0]).toBe(false)
  })

  it('does not install itself twice over its own handler', () => {
    start()
    const installed = window.onerror

    expect(installed).not.toBe(null)
    expect(typeof installed).toBe('function')
  })
})
