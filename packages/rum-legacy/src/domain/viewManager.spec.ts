import { startViewManager } from './viewManager'

describe('view manager', () => {
  let updates: any[]
  let stopManager: (() => void) | undefined

  function start(options?: { readyState?: DocumentReadyState }) {
    updates = []
    const manager = startViewManager((properties) => updates.push(properties), {
      isDocumentLoaded: () => (options?.readyState ?? 'complete') === 'complete',
    })
    stopManager = () => manager.stop()
    return manager
  }

  afterEach(() => {
    stopManager?.()
    stopManager = undefined
    if (location.hash) {
      location.hash = ''
    }
  })

  it('starts a view identified by the current location', () => {
    const manager = start()

    const view = manager.getCurrentView()
    expect(view.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(view.url).toBe(location.href)
    expect(view.referrer).toBe(document.referrer)
  })

  it('reports the first view as an initial load', () => {
    start()

    expect(updates[0].view.loading_type).toBe('initial_load')
  })

  it('reports every event count the schema requires, even the ones always zero here', () => {
    start()

    const view = updates[0].view
    expect(view.error).toEqual({ count: 0 })
    expect(view.action).toEqual({ count: 0 })
    // Resources and long tasks cannot be observed on these browsers, but the counts are part of the
    // event format and omitting them would read as missing data rather than as zero.
    expect(view.resource).toEqual({ count: 0 })
    expect(view.long_task).toEqual({ count: 0 })
    expect(view.frustration).toEqual({ count: 0 })
  })

  it('counts errors and actions into the view', () => {
    const manager = start()

    manager.addErrorCount()
    manager.addErrorCount()
    manager.addActionCount()
    manager.endView()

    const last = updates[updates.length - 1].view
    expect(last.error.count).toBe(2)
    expect(last.action.count).toBe(1)
  })

  it('increments the document version on every update so the intake can order them', () => {
    const manager = start()

    manager.endView()
    manager.endView()

    const versions = updates.map((update) => update._dd.document_version as number)
    expect(versions).toEqual([1, 2, 3])
  })

  it('reports the view as active until it ends', () => {
    const manager = start()

    expect(updates[0].view.is_active).toBe(true)

    manager.stop()
    expect(updates[updates.length - 1].view.is_active).toBe(false)
  })

  it('measures time spent in nanoseconds', () => {
    jasmine.clock().install()
    // Frozen before the view opens, not after: the view reads the wall clock when it starts, and a
    // millisecond passing between that and the line below is enough to make the measurement drift.
    const openedAt = Date.now()
    jasmine.clock().mockDate(new Date(openedAt))
    const manager = start()
    jasmine.clock().mockDate(new Date(openedAt + 2000))
    manager.endView()
    jasmine.clock().uninstall()

    // The event format uses nanoseconds, so two seconds is 2e9 and not 2000.
    expect(updates[updates.length - 1].view.time_spent).toBe(2_000_000_000)
  })

  it('never reports a negative time spent when the clock jumps backwards', () => {
    jasmine.clock().install()
    const manager = start()
    // These browsers have no performance.now(), so durations come from the wall clock, which an
    // NTP correction can move backwards.
    jasmine.clock().mockDate(new Date(Date.now() - 5000))
    manager.endView()
    jasmine.clock().uninstall()

    expect(updates[updates.length - 1].view.time_spent).toBe(0)
  })

  it('starts a new view on a hash change and closes the previous one', () => {
    const manager = start()
    const firstViewId = manager.getCurrentView().id

    location.hash = '#/orders'
    window.dispatchEvent(new Event('hashchange'))

    expect(manager.getCurrentView().id).not.toBe(firstViewId)
    const closing = updates.filter((update) => update.view.is_active === false)
    expect(closing.length).toBe(1)
  })

  it('reports the previous view as the referrer of a view started in-page', () => {
    const manager = start()
    const firstViewUrl = manager.getCurrentView().url

    manager.startView('checkout')

    // document.referrer describes how the document was reached, not how this view was, so using it
    // here would attribute every in-page navigation to whatever site linked to the page.
    expect(manager.getCurrentView().referrer).toBe(firstViewUrl)
  })

  it('keeps the document referrer for the first view', () => {
    const manager = start()

    expect(manager.getCurrentView().referrer).toBe(document.referrer)
  })

  it('reports a view started by navigation as a route change, not an initial load', () => {
    const manager = start()

    manager.startView()

    expect(updates[updates.length - 1].view.loading_type).toBe('route_change')
  })

  it('restarts the document version for each new view', () => {
    const manager = start()

    manager.startView()
    const firstUpdateOfNewView = updates[updates.length - 1]

    expect(firstUpdateOfNewView._dd.document_version).toBe(1)
  })

  it('accepts a name for a manually started view', () => {
    const manager = start()

    manager.startView('checkout')

    expect(updates[updates.length - 1].view.name).toBe('checkout')
  })

  describe('safety net', () => {
    it('does not let a failure escape into the page through a browser callback', () => {
      // The browser invokes the hashchange listener directly, so anything thrown inside it would
      // become an uncaught error on the page rather than staying inside the SDK.
      const handlers: { [eventName: string]: Array<() => void> } = {}
      spyOn(window, 'addEventListener').and.callFake((eventName: string, handler: any) => {
        handlers[eventName] = handlers[eventName] || []
        handlers[eventName].push(handler)
      })
      // Failing is switched on only around the assertion: the first update is emitted while the
      // manager is being constructed, which init already guards, and teardown emits one more.
      let failing = false
      const manager = startViewManager(() => {
        if (failing) {
          throw new Error('collection is broken')
        }
      })
      stopManager = () => manager.stop()

      failing = true
      expect(() => handlers.hashchange[0]()).not.toThrow()
      failing = false
    })
  })

  describe('navigation timings', () => {
    it('derives page load timings from performance.timing, in nanoseconds', () => {
      const navigationStart = 1_000_000
      spyOnProperty(performance, 'timing', 'get').and.returnValue({
        navigationStart,
        responseStart: navigationStart + 100,
        domInteractive: navigationStart + 200,
        domContentLoadedEventEnd: navigationStart + 300,
        domComplete: navigationStart + 400,
        loadEventEnd: navigationStart + 500,
      } as any)

      start()

      const view = updates[0].view
      expect(view.first_byte).toBe(100_000_000)
      expect(view.dom_interactive).toBe(200_000_000)
      expect(view.dom_content_loaded).toBe(300_000_000)
      expect(view.dom_complete).toBe(400_000_000)
      expect(view.load_event).toBe(500_000_000)
    })

    it('leaves out timings the browser has not reached yet', () => {
      const navigationStart = 1_000_000
      spyOnProperty(performance, 'timing', 'get').and.returnValue({
        navigationStart,
        responseStart: navigationStart + 100,
        domInteractive: 0,
        domContentLoadedEventEnd: 0,
        domComplete: 0,
        loadEventEnd: 0,
      } as any)

      start()

      const view = updates[0].view
      expect(view.first_byte).toBe(100_000_000)
      expect('dom_interactive' in view).toBe(false)
      expect('load_event' in view).toBe(false)
    })

    it('reports no timings rather than failing when performance.timing is missing', () => {
      spyOnProperty(performance, 'timing', 'get').and.returnValue(undefined as any)

      expect(() => start()).not.toThrow()
      expect('first_byte' in updates[0].view).toBe(false)
    })

    it('does not attach page load timings to a route change', () => {
      const manager = start()

      manager.startView()

      expect('first_byte' in updates[updates.length - 1].view).toBe(false)
    })
  })
})
