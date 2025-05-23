import type { RelativeTime, Observable, Context } from '@flashcatcloud/browser-core'
import { SESSION_TIME_OUT_DELAY, relativeNow, createValueHistory } from '@flashcatcloud/browser-core'
import type { LocationChange } from '../../browser/locationChangeObservable'
import type { LifeCycle } from '../lifeCycle'
import { LifeCycleEventType } from '../lifeCycle'
import type { PartialRumEvent, Hooks } from '../../hooks'
import { HookNames } from '../../hooks'

/**
 * We want to attach to an event:
 * - the url corresponding to its start
 * - the referrer corresponding to the previous view url (or document referrer for initial view)
 */

export const URL_CONTEXT_TIME_OUT_DELAY = SESSION_TIME_OUT_DELAY

export interface UrlContext {
  url: string
  referrer: string
}

export interface UrlContexts {
  findUrl: (startTime?: RelativeTime) => UrlContext | undefined
  getAllEntries: () => Context[]
  getDeletedEntries: () => RelativeTime[]
  stop: () => void
}

export function startUrlContexts(
  lifeCycle: LifeCycle,
  hooks: Hooks,
  locationChangeObservable: Observable<LocationChange>,
  location: Location
) {
  const urlContextHistory = createValueHistory<UrlContext>({ expireDelay: URL_CONTEXT_TIME_OUT_DELAY })

  let previousViewUrl: string | undefined

  lifeCycle.subscribe(LifeCycleEventType.BEFORE_VIEW_CREATED, ({ startClocks }) => {
    const viewUrl = location.href
    urlContextHistory.add(
      buildUrlContext({
        url: viewUrl,
        referrer: !previousViewUrl ? document.referrer : previousViewUrl,
      }),
      startClocks.relative
    )
    previousViewUrl = viewUrl
  })

  lifeCycle.subscribe(LifeCycleEventType.AFTER_VIEW_ENDED, ({ endClocks }) => {
    urlContextHistory.closeActive(endClocks.relative)
  })

  const locationChangeSubscription = locationChangeObservable.subscribe(({ newLocation }) => {
    const current = urlContextHistory.find()
    if (current) {
      const changeTime = relativeNow()
      urlContextHistory.closeActive(changeTime)
      urlContextHistory.add(
        buildUrlContext({
          url: newLocation.href,
          referrer: current.referrer,
        }),
        changeTime
      )
    }
  })

  function buildUrlContext({ url, referrer }: { url: string; referrer: string }) {
    return {
      url,
      referrer,
    }
  }

  hooks.register(HookNames.Assemble, ({ startTime, eventType }): PartialRumEvent | undefined => {
    const { url, referrer } = urlContextHistory.find(startTime)!

    return {
      type: eventType,
      view: {
        url,
        referrer,
      },
    }
  })

  return {
    findUrl: (startTime?: RelativeTime) => urlContextHistory.find(startTime),
    getAllEntries: () => urlContextHistory.getAllEntries(),
    getDeletedEntries: () => urlContextHistory.getDeletedEntries(),
    stop: () => {
      locationChangeSubscription.unsubscribe()
      urlContextHistory.stop()
    },
  }
}
