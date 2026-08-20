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

  it('does not release detail whose view is no longer buffered', () => {
    collect(RumEventType.VIEW, { view: { id: 'old-view' } })
    collect(RumEventType.RESOURCE, { view: { id: 'old-view' } })
    // push the old view out of the view map
    for (let i = 0; i < 60; i++) {
      collect(RumEventType.VIEW, { view: { id: `view-${i}` } })
    }

    sessionManager.setSessionHasError()
    collect(RumEventType.ERROR)

    const released = releasedAfterJitter()
    expect(released.some((event) => event.type === RumEventType.RESOURCE)).toBeFalse()
  })
})
