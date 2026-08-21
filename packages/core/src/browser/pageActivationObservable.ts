import { Observable } from '../tools/observable'
import type { Configuration } from '../domain/configuration'
import { ONE_SECOND, timeStampNow } from '../tools/utils/timeUtils'
import { addEventListeners, DOM_EVENT } from './addEventListener'

export const REACTIVATE_DEBOUNCE = ONE_SECOND

/**
 * Emits when the page transitions from an inactive (blurred / hidden) state back to active.
 *
 * Uses focus/blur as the primary signal because it is the only one that fires for Electron
 * multi-window switching, where document.visibilityState stays 'visible'. visibilitychange and
 * pageshow are added so browser-tab switches and bfcache restores are covered too. An `isInactive`
 * gate ensures only a genuine leave -> return cycle notifies (not the initial focus or an in-page
 * refocus), and a short debounce absorbs focus flicker / programmatic focus theft.
 */
export function createPageActivationObservable(configuration: Configuration): Observable<void> {
  return new Observable<void>((observable) => {
    let isInactive = false
    let lastActivationTimestamp = 0

    const notifyActivation = () => {
      if (!isInactive) {
        return
      }
      isInactive = false
      const now = timeStampNow()
      if (now - lastActivationTimestamp < REACTIVATE_DEBOUNCE) {
        return
      }
      lastActivationTimestamp = now
      observable.notify()
    }

    const { stop } = addEventListeners(
      configuration,
      window,
      [DOM_EVENT.BLUR, DOM_EVENT.FOCUS, DOM_EVENT.VISIBILITY_CHANGE, DOM_EVENT.PAGE_SHOW],
      (event) => {
        // With capture on window, focus/blur of descendant elements are also received (they don't
        // bubble but are captured). Only window-level focus/blur indicate page (de)activation.
        if ((event.type === DOM_EVENT.BLUR || event.type === DOM_EVENT.FOCUS) && event.target !== window) {
          return
        }
        if (event.type === DOM_EVENT.BLUR) {
          isInactive = true
        } else if (event.type === DOM_EVENT.VISIBILITY_CHANGE) {
          if (document.visibilityState === 'hidden') {
            isInactive = true
          } else {
            notifyActivation()
          }
        } else {
          // focus or pageshow
          notifyActivation()
        }
      },
      { capture: true }
    )

    return stop
  })
}
