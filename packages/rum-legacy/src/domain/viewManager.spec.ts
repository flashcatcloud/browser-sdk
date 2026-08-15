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
    manager.flush()

    const last = updates[updates.length - 1].view
    expect(last.error.count).toBe(2)
    expect(last.action.count).toBe(1)
  })

  it('increments the document version on every update so the intake can order them', () => {
    const manager = start()

    manager.flush()
    manager.flush()

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
    const manager = start()
    jasmine.clock().mockDate(new Date(Date.now() + 2000))
    manager.flush()
    jasmine.clock().uninstall()

    // The event format uses nanoseconds, so two seconds is 2e9 and not 2000.
    expect(updates[updates.length - 1].view.time_spent).toBe(2_000_000_000)
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
