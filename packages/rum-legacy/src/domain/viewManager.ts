import { monitor } from '../tools/monitor'
import { dateNow } from '../tools/timeUtils'
import { getZoneJsOriginalValue } from '../tools/zoneJs'
import { generateUUID } from '../transport/intakeUrl'
import type { ViewContext } from './eventAssembly'

const INITIAL_LOAD = 'initial_load'
const ROUTE_CHANGE = 'route_change'

export interface ViewManagerOptions {
  isDocumentLoaded: () => boolean
}

interface CurrentView extends ViewContext {
  name?: string
  loadingType: string
  startTime: number
  errorCount: number
  actionCount: number
  documentVersion: number
}

export function startViewManager(
  // The view context is handed to the callback rather than looked up from the manager: the first
  // update is emitted while this function is still running, so the caller cannot yet hold a
  // reference to the manager it is constructing.
  onViewUpdate: (properties: { [key: string]: any }, view: ViewContext) => void,
  options?: Partial<ViewManagerOptions>
) {
  const isDocumentLoaded = options?.isDocumentLoaded ?? (() => document.readyState === 'complete')

  let currentView = createView(INITIAL_LOAD)
  let stopped = false

  function createView(loadingType: string, name?: string, previousViewUrl?: string): CurrentView {
    return {
      id: generateUUID(),
      url: location.href,
      // Where this view was reached from. For a view started in-page that is the previous view's
      // url; only the first view of the document comes from outside it.
      referrer: previousViewUrl ?? document.referrer,
      name,
      loadingType,
      startTime: dateNow(),
      errorCount: 0,
      actionCount: 0,
      documentVersion: 0,
    }
  }

  function emit(isActive: boolean): void {
    currentView.documentVersion++

    const view: { [key: string]: any } = {
      loading_type: currentView.loadingType,
      time_spent: toServerDuration(elapsedSince(currentView.startTime)),
      is_active: isActive,
      // These counts are always zero on these browsers, but they are part of the event format.
      // Leaving them out would read downstream as missing data rather than as a real zero.
      error: { count: currentView.errorCount },
      action: { count: currentView.actionCount },
      resource: { count: 0 },
      long_task: { count: 0 },
      frustration: { count: 0 },
    }

    if (currentView.name) {
      view.name = currentView.name
    }

    if (currentView.loadingType === INITIAL_LOAD) {
      addNavigationTimings(view)
    }

    onViewUpdate(
      {
        view,
        _dd: { document_version: currentView.documentVersion },
      },
      { id: currentView.id, url: currentView.url, referrer: currentView.referrer, startTime: currentView.startTime }
    )
  }

  function endCurrentView(): void {
    emit(false)
  }

  function startNewView(loadingType: string, name?: string): void {
    const previousViewUrl = currentView.url
    endCurrentView()
    currentView = createView(loadingType, name, previousViewUrl)
    emit(true)
  }

  function onHashChange(): void {
    if (!stopped) {
      // The only route change these browsers can report: there is no History API to hook into.
      startNewView(ROUTE_CHANGE)
    }
  }

  function onLoad(): void {
    if (!stopped) {
      // Re-emit once the load event has landed so the page load timings are complete.
      emit(true)
    }
  }

  // Wrapped: the browser calls these, so an internal failure would leave the SDK and surface as an
  // uncaught error in the page.
  const guardedOnHashChange = monitor(onHashChange)
  const guardedOnLoad = monitor(onLoad)
  const addEventListener = getZoneJsOriginalValue(window, 'addEventListener')
  addEventListener.call(window, 'hashchange', guardedOnHashChange)
  if (!isDocumentLoaded()) {
    addEventListener.call(window, 'load', guardedOnLoad)
  }

  emit(true)

  return {
    getCurrentView(): ViewContext {
      return {
        id: currentView.id,
        url: currentView.url,
        referrer: currentView.referrer,
        startTime: currentView.startTime,
      }
    },

    startView(name?: string): void {
      if (!stopped) {
        startNewView(ROUTE_CHANGE, name)
      }
    },

    /**
     * Renames the current view in place rather than starting a new one.
     *
     * An update has already gone out under the old name and cannot be retracted, but every update
     * of a view shares its id and the intake keeps the one with the highest document version, so
     * the rename lands. Starting a new view instead would invent a navigation that never happened
     * and split the view's counts across two ids.
     */
    setViewName(name: string): void {
      if (!stopped) {
        currentView.name = name
        emit(true)
      }
    },

    addErrorCount(): void {
      currentView.errorCount++
    },

    addActionCount(): void {
      currentView.actionCount++
    },

    /**
     * Sends the closing update for the current view without shutting collection down.
     *
     * Used on page exit, where tearing down would be wrong: beforeunload can fire for a navigation
     * the user then cancels, and the page would be left with a dead SDK. A later exit sends another
     * update with a higher document version, which the intake treats as the newer state.
     */
    endView(): void {
      if (!stopped) {
        endCurrentView()
      }
    },

    stop(): void {
      if (stopped) {
        return
      }
      endCurrentView()
      stopped = true
      const removeEventListener = getZoneJsOriginalValue(window, 'removeEventListener')
      removeEventListener.call(window, 'hashchange', guardedOnHashChange)
      removeEventListener.call(window, 'load', guardedOnLoad)
    },
  }
}

/*
 * performance.timing holds absolute epoch timestamps. The event format wants durations relative to
 * the navigation start, expressed in nanoseconds.
 *
 * A zero means the browser has not reached that milestone, not that it took no time, so those are
 * left out rather than reported as 0.
 */
function addNavigationTimings(view: { [key: string]: any }): void {
  // Read off window rather than as a bare identifier: where the property does not exist at all, a
  // bare reference throws a ReferenceError instead of evaluating to undefined, and this runs inside
  // the first view emitted during init.
  const timing = window.performance && window.performance.timing
  if (!timing || !timing.navigationStart) {
    return
  }

  const navigationStart = timing.navigationStart
  const timings: Array<[string, number]> = [
    ['first_byte', timing.responseStart],
    ['dom_interactive', timing.domInteractive],
    ['dom_content_loaded', timing.domContentLoadedEventEnd],
    ['dom_complete', timing.domComplete],
    ['load_event', timing.loadEventEnd],
  ]

  for (let i = 0; i < timings.length; i++) {
    const name = timings[i][0]
    const timestamp = timings[i][1]
    if (timestamp > 0 && timestamp >= navigationStart) {
      view[name] = toServerDuration(timestamp - navigationStart)
    }
  }
}

function toServerDuration(durationInMilliseconds: number): number {
  return Math.round(durationInMilliseconds * 1e6)
}

/**
 * Durations here come from the wall clock, because these browsers have no monotonic
 * performance.now(). A clock correction can therefore move time backwards mid-view, and a negative
 * duration is not a measurement, it is a broken one. Report no elapsed time instead.
 */
function elapsedSince(startTime: number): number {
  return Math.max(0, dateNow() - startTime)
}
