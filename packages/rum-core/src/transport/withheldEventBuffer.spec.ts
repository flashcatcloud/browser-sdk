import type { Context } from '@flashcatcloud/browser-core'
import { ONE_SECOND, PageExitReason } from '@flashcatcloud/browser-core'
import type { Clock } from '@flashcatcloud/browser-core/test'
import { mockClock, registerCleanupTask } from '@flashcatcloud/browser-core/test'
import { createRumSessionManagerMock } from '../../test'
import { RumEventType } from '../rawRumEvent.types'
import type { RumEvent } from '../rumEvent.types'
import { LifeCycle, LifeCycleEventType } from '../domain/lifeCycle'
import {
  WITHHELD_BUFFER_DURATION,
  WITHHELD_BUFFER_EVENTS_LIMIT,
  WITHHELD_BUFFER_RELEASE_MAX_DELAY,
  computeReleaseDelay,
  startWithheldEventBuffer,
} from './withheldEventBuffer'

describe('startWithheldEventBuffer', () => {
  let clock: Clock
  let lifeCycle: LifeCycle
  let sessionManager: ReturnType<typeof createRumSessionManagerMock>
  let forwarded: Array<RumEvent & Context>

  function collect(type: RumEventType, overrides: Context = {}) {
    const event = {
      type,
      date: 1234,
      view: { id: 'view-1' },
      session: {},
      ...(type === RumEventType.RESOURCE ? { resource: { status_code: 200 } } : {}),
      ...overrides,
    } as unknown as RumEvent & Context
    lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, event)
    return event
  }

  /** Everything the buffer released, once the release jitter has elapsed. */
  function releasedAfterJitter() {
    clock.tick(WITHHELD_BUFFER_RELEASE_MAX_DELAY)
    return forwarded
  }

  beforeEach(() => {
    clock = mockClock()
    lifeCycle = new LifeCycle()
    forwarded = []
    sessionManager = createRumSessionManagerMock().setTrackedOnError()
    const { stop } = startWithheldEventBuffer(lifeCycle, sessionManager, (event) => forwarded.push(event))
    registerCleanupTask(() => {
      stop()
      clock.cleanup()
    })
  })

  it('forwards immediately when the session is not withholding', () => {
    sessionManager.setTrackedWithSessionReplay()

    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)

    expect(forwarded.length).toBe(2)
  })

  it('uploads nothing while the session has not reported an error', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)
    collect(RumEventType.ACTION)
    clock.tick(30 * ONE_SECOND)

    expect(forwarded.length).toBe(0)
  })

  it('releases the buffer once the session reports an error', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)
    collect(RumEventType.ACTION)

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)

    const released = releasedAfterJitter()
    expect(released.map((event) => event.type)).toEqual([
      RumEventType.VIEW,
      RumEventType.RESOURCE,
      RumEventType.ACTION,
      RumEventType.ERROR,
    ])
  })

  it('marks how far back the released detail reaches', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE, { date: 4321 })

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)

    const view = releasedAfterJitter().find((event) => event.type === RumEventType.VIEW)!
    expect((view.session as Context).detail_sampled_from).toBe(4321)
  })

  it('keeps only the latest event of a view, since a view event supersedes the ones before it', () => {
    collect(RumEventType.VIEW, { documentVersion: 1 })
    collect(RumEventType.VIEW, { documentVersion: 2 })
    collect(RumEventType.VIEW, { documentVersion: 3 })

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)

    const views = releasedAfterJitter().filter((event) => event.type === RumEventType.VIEW)
    expect(views.length).toBe(1)
    expect((views[0] as unknown as Context).documentVersion).toBe(3)
  })

  it('drops detail that has aged out of the window', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)
    clock.tick(WITHHELD_BUFFER_DURATION + ONE_SECOND)
    collect(RumEventType.ACTION)

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)

    const types = releasedAfterJitter().map((event) => event.type)
    expect(types).not.toContain(RumEventType.RESOURCE)
    expect(types).toContain(RumEventType.ACTION)
  })

  it('drops the buffer when the session expires without ever reporting an error', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)

    sessionManager.setNotTracked()
    collect(RumEventType.RESOURCE)

    expect(releasedAfterJitter().filter((event) => event.type === RumEventType.RESOURCE).length).toBe(1)
  })

  it('releases on page exit when the session errored without the buffer having noticed yet', () => {
    // the event arrives synchronously, but the session state behind it is written through a lock
    // that can defer the write - so the buffer can still read the session as withholding
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)
    sessionManager.setSessionHasError()
    // no further event, so nothing re-reads the session before the page goes

    lifeCycle.notify(LifeCycleEventType.PAGE_MAY_EXIT, { reason: PageExitReason.UNLOADING })

    expect(forwarded.map((event) => event.type)).toEqual([RumEventType.VIEW, RumEventType.RESOURCE])
  })

  it('drops the buffer on page exit rather than uploading a session that never errored', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)

    lifeCycle.notify(LifeCycleEventType.PAGE_MAY_EXIT, { reason: PageExitReason.UNLOADING })

    expect(releasedAfterJitter().length).toBe(0)
  })

  it('sends a release that is still waiting on jitter when the page is about to go', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)
    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)
    // still inside the jitter window: the error rides along with the buffer, so nothing left yet
    expect(forwarded.length).toBe(0)

    lifeCycle.notify(LifeCycleEventType.PAGE_MAY_EXIT, { reason: PageExitReason.UNLOADING })

    expect(forwarded.map((event) => event.type)).toEqual([RumEventType.VIEW, RumEventType.RESOURCE, RumEventType.ERROR])
  })

  it('drops long tasks before actions when it runs out of room', () => {
    collect(RumEventType.VIEW)
    for (let i = 0; i < WITHHELD_BUFFER_EVENTS_LIMIT; i++) {
      collect(RumEventType.LONG_TASK)
    }
    collect(RumEventType.ACTION)

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)

    expect(releasedAfterJitter().map((event) => event.type)).toContain(RumEventType.ACTION)
  })

  it('never drops errors, however full the buffer gets', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.ERROR, { date: 1 })
    for (let i = 0; i < WITHHELD_BUFFER_EVENTS_LIMIT * 2; i++) {
      collect(RumEventType.LONG_TASK)
    }

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR, { date: 2 })

    const errors = releasedAfterJitter().filter((event) => event.type === RumEventType.ERROR)
    expect(errors.some((event) => event.date === 1)).toBeTrue()
  })

  it('gives up the newest error rather than the first one when only errors are left', () => {
    collect(RumEventType.VIEW)
    for (let i = 0; i < WITHHELD_BUFFER_EVENTS_LIMIT + 20; i++) {
      collect(RumEventType.ERROR, { date: i })
    }

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR, { date: 9999 })

    const dates = releasedAfterJitter()
      .filter((event) => event.type === RumEventType.ERROR)
      .map((event) => event.date)
    // the first error - the one the session is about - survives
    expect(dates).toContain(0)
  })

  it('releases every detail alongside the view it hangs from', () => {
    // the backend builds the session row out of view events, so a detail without its view would be
    // unreachable however the view came to be missing
    for (let i = 0; i < 60; i++) {
      collect(RumEventType.VIEW, { view: { id: `view-${i}` } })
      collect(RumEventType.RESOURCE, { view: { id: `view-${i}` } })
    }

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR, { view: { id: 'view-59' } })

    const released = releasedAfterJitter()
    const releasedViewIds = new Set(
      released.filter((event) => event.type === RumEventType.VIEW).map((event) => event.view.id)
    )
    released
      .filter((event) => event.type !== RumEventType.VIEW)
      .forEach((event) => expect(releasedViewIds.has(event.view.id)).toBeTrue())
  })

  it('lets a view go once none of its detail is left inside the window', () => {
    collect(RumEventType.VIEW, { view: { id: 'old-view' } })
    collect(RumEventType.RESOURCE, { view: { id: 'old-view' } })
    clock.tick(WITHHELD_BUFFER_DURATION + ONE_SECOND)
    collect(RumEventType.VIEW, { view: { id: 'current-view' } })

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR, { view: { id: 'current-view' } })

    const releasedViewIds = releasedAfterJitter()
      .filter((event) => event.type === RumEventType.VIEW)
      .map((event) => event.view.id)
    expect(releasedViewIds).not.toContain('old-view')
    expect(releasedViewIds).toContain('current-view')
  })
})

describe('computeReleaseDelay', () => {
  function randomSessionId() {
    const hex = '0123456789abcdef'
    let id = ''
    for (let i = 0; i < 36; i++) {
      id += i === 8 || i === 13 || i === 18 || i === 23 ? '-' : hex[Math.floor(Math.random() * 16)]
    }
    return id
  }

  it('is stable for a given session', () => {
    const id = randomSessionId()

    expect(computeReleaseDelay(id)).toBe(computeReleaseDelay(id))
  })

  it('stays within the release window', () => {
    for (let i = 0; i < 1000; i++) {
      const delay = computeReleaseDelay(randomSessionId())
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThan(WITHHELD_BUFFER_RELEASE_MAX_DELAY)
    }
  })

  it('spreads sessions across the window rather than bunching them up', () => {
    // session ids are same-length strings over one small alphabet, so a running sum of their
    // character codes lands nearly all of them within a few hundred ms of each other - which delays
    // the herd instead of spreading it
    const bucketCount = 10
    const buckets = new Array<number>(bucketCount).fill(0)
    const samples = 10000
    for (let i = 0; i < samples; i++) {
      const bucket = Math.floor(
        (computeReleaseDelay(randomSessionId()) / WITHHELD_BUFFER_RELEASE_MAX_DELAY) * bucketCount
      )
      buckets[bucket] += 1
    }

    buckets.forEach((count) => {
      // a flat spread puts 10% in each; allow a wide margin and still catch bunching
      expect(count / samples).toBeGreaterThan(0.05)
      expect(count / samples).toBeLessThan(0.2)
    })
  })
})
