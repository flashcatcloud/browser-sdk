import type { Context } from '@flashcatcloud/browser-core'
import { ONE_SECOND, PageExitReason } from '@flashcatcloud/browser-core'
import type { Clock } from '@flashcatcloud/browser-core/test'
import { mockClock, registerCleanupTask } from '@flashcatcloud/browser-core/test'
import { createRumSessionManagerMock } from '../../test'
import { RumEventType } from '../rawRumEvent.types'
import type { RumEvent } from '../rumEvent.types'
import { LifeCycle, LifeCycleEventType } from '../domain/lifeCycle'
import {
  WITHHELD_BUFFER_BYTES_LIMIT,
  WITHHELD_BUFFER_DURATION,
  WITHHELD_BUFFER_EVENTS_LIMIT,
  WITHHELD_BUFFER_VIEWS_LIMIT,
  WITHHELD_BUFFER_RELEASE_MAX_DELAY,
  computeReleaseDelay,
  startWithheldEventBuffer,
} from './withheldEventBuffer'

describe('startWithheldEventBuffer', () => {
  let clock: Clock
  let lifeCycle: LifeCycle
  let sessionManager: ReturnType<typeof createRumSessionManagerMock>
  let forwarded: Array<RumEvent & Context>
  let stopBuffer: () => void

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
    stopBuffer = stop
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
    collect(RumEventType.ERROR, { date: 9999 })

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

  it('drops the buffer, and what is still arriving for it, when the session ends without an error', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)

    sessionManager.setNotTracked()
    collect(RumEventType.RESOURCE)

    expect(releasedAfterJitter().length).toBe(0)
  })

  it('forwards the events of a new session that withholds nothing', () => {
    sessionManager.setId('session-1')
    collect(RumEventType.VIEW, { session: { id: 'session-1' } })

    sessionManager.setId('session-2').setTrackedWithSessionReplay()
    collect(RumEventType.RESOURCE, { session: { id: 'session-2' } })

    expect(releasedAfterJitter().map((event) => (event.session as Context).id)).toEqual(['session-2'])
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

  it('keeps the buffer when the page is only hidden, since it comes back', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE, { date: 111 })

    lifeCycle.notify(LifeCycleEventType.PAGE_MAY_EXIT, { reason: PageExitReason.HIDDEN })
    expect(forwarded.length).toBe(0)

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)

    const dates = releasedAfterJitter().map((event) => event.date)
    expect(dates).toContain(111)
  })

  it('records on the session how far back the released detail reaches', () => {
    const spy = spyOn(sessionManager, 'setSessionDetailSampledFrom').and.callThrough()
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE, { date: 4321 })

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR, { date: 9999 })
    releasedAfterJitter()

    // kept on the session, because the batch upserts views by id and the next ordinary view update
    // would otherwise replace the stamped one before anything is sent
    expect(spy).toHaveBeenCalledWith(4321, 'session-id')
  })

  it('drops the buffer when the session ends without ever having errored', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)

    lifeCycle.notify(LifeCycleEventType.SESSION_EXPIRED)

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

  it('drops a straggler of a session whose buffer was already thrown away', () => {
    collect(RumEventType.VIEW, { session: { id: 'session-id' } })
    collect(RumEventType.RESOURCE, { session: { id: 'session-id' } })

    lifeCycle.notify(LifeCycleEventType.SESSION_EXPIRED)
    sessionManager.setNotTracked()

    // a request that started before the session ended completes after it, still carrying its id -
    // uploading it would store the very session the withholding was there to avoid
    collect(RumEventType.RESOURCE, { session: { id: 'session-id' } })

    expect(releasedAfterJitter().length).toBe(0)
  })

  it('does not let a straggler of the previous session ride the new one buffer', () => {
    sessionManager.setId('session-1')
    collect(RumEventType.VIEW, { session: { id: 'session-1' } })
    collect(RumEventType.RESOURCE, { session: { id: 'session-1' } })

    lifeCycle.notify(LifeCycleEventType.SESSION_EXPIRED)
    sessionManager.setId('session-2')

    collect(RumEventType.RESOURCE, { session: { id: 'session-1' } })
    collect(RumEventType.VIEW, { session: { id: 'session-2' } })

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR, { session: { id: 'session-2' } })

    const releasedSessionIds = releasedAfterJitter().map((event) => (event.session as Context).id)
    expect(releasedSessionIds).toEqual(['session-2', 'session-2'])
  })

  it('keeps the minute before the error when the release timer is held back', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE, { date: 111 })

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)

    // a backgrounded tab clamps timers to about once a minute, so the release runs long after it
    // was scheduled - the window it releases has to be the one around the error, not around now
    clock.setDate(new Date(Date.now() + WITHHELD_BUFFER_DURATION + ONE_SECOND))
    clock.tick(WITHHELD_BUFFER_RELEASE_MAX_DELAY)

    expect(forwarded.map((event) => event.date)).toContain(111)
  })

  it('still drops a straggler of a session discarded several renewals ago', () => {
    sessionManager.setId('session-1')
    collect(RumEventType.VIEW, { session: { id: 'session-1' } })
    lifeCycle.notify(LifeCycleEventType.SESSION_EXPIRED)

    sessionManager.setId('session-2')
    collect(RumEventType.VIEW, { session: { id: 'session-2' } })
    lifeCycle.notify(LifeCycleEventType.SESSION_EXPIRED)

    sessionManager.setId('session-3')
    collect(RumEventType.VIEW, { session: { id: 'session-3' } })

    // a request that outlived two withheld sessions finally completes
    collect(RumEventType.RESOURCE, { session: { id: 'session-1' } })

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR, { session: { id: 'session-3' } })

    const releasedSessionIds = releasedAfterJitter().map((event) => (event.session as Context).id)
    expect(releasedSessionIds).toEqual(['session-3', 'session-3'])
  })

  it('drops the buffer when the session stops withholding without having errored', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)

    // an older SDK sharing the same session store does not know this tracking type and redraws it:
    // the session stops withholding, but it never reported an error
    sessionManager.setTrackedWithoutSessionReplay()
    collect(RumEventType.RESOURCE)

    expect(releasedAfterJitter().length).toBe(0)
  })

  it('releases the views oldest first, since a session is built out of the first one to arrive', () => {
    collect(RumEventType.VIEW, { date: 1000, view: { id: 'view-1' } })
    collect(RumEventType.RESOURCE, { view: { id: 'view-1' } })
    collect(RumEventType.VIEW, { date: 2000, view: { id: 'view-2' } })
    collect(RumEventType.RESOURCE, { view: { id: 'view-2' } })
    collect(RumEventType.VIEW, { date: 3000, view: { id: 'view-3' } })
    collect(RumEventType.RESOURCE, { view: { id: 'view-3' } })
    // a late update of the first view, which puts the oldest view last in the buffer
    collect(RumEventType.VIEW, { date: 1000, view: { id: 'view-1' } })

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR, { view: { id: 'view-3' } })

    const releasedViewDates = releasedAfterJitter()
      .filter((event) => event.type === RumEventType.VIEW)
      .map((event) => event.date)
    expect(releasedViewDates).toEqual([1000, 2000, 3000])
  })

  it('marks the detail as starting at the earliest event, not at the first one held', () => {
    collect(RumEventType.VIEW)
    // a request that took minutes is only held once it finishes, but it started well before that
    collect(RumEventType.RESOURCE, { date: 5000 })
    collect(RumEventType.RESOURCE, { date: 1000 })

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR, { date: 9000 })

    const view = releasedAfterJitter().find((event) => event.type === RumEventType.VIEW)!
    expect((view.session as Context).detail_sampled_from).toBe(1000)
  })

  it('spreads the release over the window it computed for this session', () => {
    const delay = computeReleaseDelay('session-id')
    // the fixture itself has to have something to spread, or this proves nothing
    expect(delay).toBeGreaterThan(0)

    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)
    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)

    clock.tick(delay - 1)
    expect(forwarded.length).toBe(0)

    clock.tick(1)
    expect(forwarded.length).toBeGreaterThan(0)
  })

  it('gives up detail once the bytes budget is spent, not only once the count is', () => {
    const bulk = 'x'.repeat(8000)
    collect(RumEventType.VIEW)
    const heldCount = Math.ceil(WITHHELD_BUFFER_BYTES_LIMIT / 8000) + 2
    for (let i = 0; i < heldCount; i++) {
      collect(RumEventType.LONG_TASK, { date: i + 1, context: { bulk } })
    }

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)

    const releasedLongTasks = releasedAfterJitter().filter((event) => event.type === RumEventType.LONG_TASK)
    expect(releasedLongTasks.length).toBeLessThan(heldCount)
  })

  it('gives up requests that succeeded before those that failed', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE, { resource: { status_code: 500 }, date: 500 })
    collect(RumEventType.RESOURCE, { resource: { status_code: 0 }, date: 1 })
    for (let i = 0; i < WITHHELD_BUFFER_EVENTS_LIMIT; i++) {
      collect(RumEventType.RESOURCE, { date: 200 })
    }

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)

    const releasedDates = releasedAfterJitter().map((event) => event.date)
    expect(releasedDates).toContain(500)
    expect(releasedDates).toContain(1)
    expect(releasedDates.filter((date) => date === 200).length).toBeLessThan(WITHHELD_BUFFER_EVENTS_LIMIT)
  })

  it('keeps no more views than its limit, however many the page goes through', () => {
    const viewCount = WITHHELD_BUFFER_VIEWS_LIMIT + 10
    for (let i = 0; i < viewCount; i++) {
      collect(RumEventType.VIEW, { date: i + 1, view: { id: `view-${i}` } })
      collect(RumEventType.RESOURCE, { view: { id: `view-${i}` } })
    }

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR, { view: { id: `view-${viewCount - 1}` } })

    const releasedViews = releasedAfterJitter().filter((event) => event.type === RumEventType.VIEW)
    expect(releasedViews.length).toBe(WITHHELD_BUFFER_VIEWS_LIMIT)
  })

  it('drops what has aged out even when the release comes from the page going', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE, { date: 111 })
    // another tab marked the session; this one collects nothing further before the page goes
    clock.tick(WITHHELD_BUFFER_DURATION + ONE_SECOND)
    sessionManager.setSessionHasError()

    lifeCycle.notify(LifeCycleEventType.PAGE_MAY_EXIT, { reason: PageExitReason.UNLOADING })

    expect(forwarded.map((event) => event.date)).not.toContain(111)
  })

  it('forwards a straggler of a session that was never withholding', () => {
    sessionManager.setId('session-2')
    collect(RumEventType.VIEW, { session: { id: 'session-2' } })

    // a request of an earlier, plainly sampled session completes now: it was never withheld from
    // anyone, and dropping it would lose an event of a session that is already stored
    collect(RumEventType.RESOURCE, { session: { id: 'session-1' } })

    expect(forwarded.map((event) => (event.session as Context).id)).toEqual(['session-1'])
  })

  it('sends a release that is still waiting on jitter when the session ends', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)
    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)
    expect(forwarded.length).toBe(0)

    lifeCycle.notify(LifeCycleEventType.SESSION_EXPIRED)

    expect(forwarded.map((event) => event.type)).toEqual([RumEventType.VIEW, RumEventType.RESOURCE, RumEventType.ERROR])
  })

  it('forwards nothing into a batch that has been stopped', () => {
    collect(RumEventType.VIEW)
    collect(RumEventType.RESOURCE)
    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)

    stopBuffer()
    clock.tick(WITHHELD_BUFFER_RELEASE_MAX_DELAY)

    expect(forwarded.length).toBe(0)
  })

  it('keeps the view an error hangs from even when the view cap has to evict one', () => {
    const last = WITHHELD_BUFFER_VIEWS_LIMIT - 1
    // a page that has been through exactly as many views as the buffer will hold
    for (let i = 0; i <= last; i++) {
      collect(RumEventType.VIEW, { date: i + 1, view: { id: `view-${i}` } })
      collect(RumEventType.RESOURCE, { view: { id: `view-${i}` } })
    }
    // every earlier view is updated late, which moves each of them behind the current one - so the
    // view in progress ends up the oldest entry, and the cap takes from the oldest
    for (let i = 0; i < last; i++) {
      collect(RumEventType.VIEW, { date: i + 1, view: { id: `view-${i}` } })
    }
    // one more late update, for a view old enough to have been dropped already, tips it over the cap
    collect(RumEventType.VIEW, { date: 1, view: { id: 'long-gone-view' } })

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR, { view: { id: `view-${last}` } })

    expect(releasedAfterJitter().map((event) => event.type)).toContain(RumEventType.ERROR)
  })

  it('keeps the view an error hangs from when a view that already ended is updated late', () => {
    collect(RumEventType.VIEW, { date: 1000, view: { id: 'first-view' } })
    collect(RumEventType.VIEW, { date: 2000, view: { id: 'second-view' } })
    // nothing happens in the second view for longer than the window
    clock.tick(WITHHELD_BUFFER_DURATION + ONE_SECOND)
    // a late update of the view that already ended: it carries that view's start date, so it must
    // not become current again - otherwise the view the error hangs from is the one pruned away
    collect(RumEventType.VIEW, { date: 1000, view: { id: 'first-view' } })

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR, { view: { id: 'second-view' } })

    expect(releasedAfterJitter().map((event) => event.type)).toContain(RumEventType.ERROR)
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
