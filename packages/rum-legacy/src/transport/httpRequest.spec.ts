import { createHttpRequest } from './httpRequest'

/**
 * IE9 only added onload/onerror/onprogress to XMLHttpRequest in IE10, so the fake below behaves
 * like IE9 does: assigning onload is possible but nothing ever calls it. A transport that relies on
 * onload therefore looks fine in these specs' modern host browser and silently never completes on
 * the browsers this build exists for.
 */
interface FakeXhr {
  method?: string
  url?: string
  async?: boolean
  body?: unknown
  headers: Array<[string, string]>
  assignedHandlers: string[]
  readyState: number
  status: number
  open: (method: string, url: string, async?: boolean) => void
  send: (body?: unknown) => void
  setRequestHeader: (name: string, value: string) => void
  onreadystatechange?: () => void
  onload?: () => void
  complete: (status: number) => void
}

describe('http request', () => {
  let sent: FakeXhr[]
  let originalXhr: typeof XMLHttpRequest
  let sendShouldThrow: boolean

  function createFakeXhr(): FakeXhr {
    const xhr: FakeXhr = {
      headers: [],
      assignedHandlers: [],
      readyState: 0,
      status: 0,
      open(method, url, async) {
        xhr.method = method
        xhr.url = url
        xhr.async = async
      },
      send(body) {
        xhr.body = body
        if (sendShouldThrow) {
          throw new Error('network is down')
        }
      },
      setRequestHeader(name, value) {
        xhr.headers.push([name, value])
      },
      complete(status) {
        xhr.readyState = 4
        xhr.status = status
        // Deliberately only the IE9 handler.
        if (xhr.onreadystatechange) {
          xhr.onreadystatechange()
        }
      },
    }

    // Record which handlers the implementation assigns, so a spec can assert it does not depend on
    // one that IE9 never fires.
    for (const handler of ['onreadystatechange', 'onload', 'onerror'] as const) {
      let value: (() => void) | undefined
      Object.defineProperty(xhr, handler, {
        get: () => value,
        set: (newValue) => {
          value = newValue
          xhr.assignedHandlers.push(handler)
        },
      })
    }

    return xhr
  }

  beforeEach(() => {
    sent = []
    sendShouldThrow = false
    originalXhr = window.XMLHttpRequest
    ;(window as any).XMLHttpRequest = function () {
      const xhr = createFakeXhr()
      sent.push(xhr)
      return xhr
    }
  })

  afterEach(() => {
    window.XMLHttpRequest = originalXhr
  })

  const buildUrl = () => 'https://example.com/rum-intake/?ddforward=x'

  it('posts the payload to the built url', () => {
    createHttpRequest(buildUrl).send('{"a":1}')

    expect(sent.length).toBe(1)
    expect(sent[0].method).toBe('POST')
    expect(sent[0].url).toBe('https://example.com/rum-intake/?ddforward=x')
    expect(sent[0].body).toBe('{"a":1}')
  })

  it('sends asynchronously', () => {
    createHttpRequest(buildUrl).send('{}')

    expect(sent[0].async).toBe(true)
  })

  it('does not set a content type, so the request stays a simple request', () => {
    createHttpRequest(buildUrl).send('{}')

    expect(sent[0].headers).toEqual([])
  })

  it('completes through onreadystatechange, which is the only handler IE9 fires', () => {
    const onResponse = jasmine.createSpy('onResponse')
    createHttpRequest(buildUrl, onResponse).send('{}')

    expect(sent[0].assignedHandlers).toContain('onreadystatechange')
    sent[0].complete(202)

    expect(onResponse).toHaveBeenCalledWith(202)
  })

  it('does not report a response before the request finished', () => {
    const onResponse = jasmine.createSpy('onResponse')
    createHttpRequest(buildUrl, onResponse).send('{}')

    sent[0].readyState = 2
    sent[0].onreadystatechange!()

    expect(onResponse).not.toHaveBeenCalled()
  })

  it('builds a fresh url for every request', () => {
    let count = 0
    const request = createHttpRequest(() => `https://example.com/?n=${count++}`)

    request.send('{}')
    request.send('{}')

    expect(sent[0].url).not.toBe(sent[1].url)
  })

  it('sends synchronously on exit, because there is no sendBeacon to fall back on', () => {
    createHttpRequest(buildUrl).sendOnExit('{}')

    expect(sent[0].async).toBe(false)
  })

  it('never lets a transport failure reach the host page', () => {
    sendShouldThrow = true

    expect(() => createHttpRequest(buildUrl).send('{}')).not.toThrow()
    expect(() => createHttpRequest(buildUrl).sendOnExit('{}')).not.toThrow()
  })

  it('never lets a failing response handler reach the host page', () => {
    createHttpRequest(buildUrl, () => {
      throw new Error('handler is broken')
    }).send('{}')

    expect(() => sent[0].complete(500)).not.toThrow()
  })

  it('survives a browser that cannot create an XMLHttpRequest at all', () => {
    ;(window as any).XMLHttpRequest = function () {
      throw new Error('blocked')
    }

    expect(() => createHttpRequest(buildUrl).send('{}')).not.toThrow()
  })
})
