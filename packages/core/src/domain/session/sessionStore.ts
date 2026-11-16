import { clearInterval, setInterval } from '../../tools/timer'
import { Observable } from '../../tools/observable'
import { ONE_SECOND, dateNow } from '../../tools/utils/timeUtils'
import { throttle } from '../../tools/utils/functionUtils'
import { generateUUID } from '../../tools/utils/stringUtils'
import type { InitConfiguration, Configuration } from '../configuration'
import { display } from '../../tools/display'
import { DOM_EVENT, addEventListener } from '../../browser/addEventListener'
import { selectCookieStrategy, initCookieStrategy } from './storeStrategies/sessionInCookie'
import type { SessionStoreStrategyType } from './storeStrategies/sessionStoreStrategy'
import { SESSION_STORE_KEY } from './storeStrategies/sessionStoreStrategy'
import {
  getExpiredSessionState,
  expandSessionState,
  isSessionInExpiredState,
  isSessionInNotStartedState,
  isSessionStarted,
} from './sessionState'
import type { SessionState } from './sessionState'
import { initLocalStorageStrategy, selectLocalStorageStrategy } from './storeStrategies/sessionInLocalStorage'
import { processSessionStoreOperations } from './sessionStoreOperations'
import { SessionPersistence } from './sessionConstants'

export interface SessionStore {
  expandOrRenewSession: () => void
  expandSession: () => void
  getSession: () => SessionState
  /** FLASHCAT FORK - see `ANONYMOUS_ID_SETTLE_DELAY`. */
  isAnonymousIdSettling: () => boolean
  restartSession: () => void
  renewObservable: Observable<void>
  expireObservable: Observable<void>
  sessionStateUpdateObservable: Observable<{ previousState: SessionState; newState: SessionState }>
  expire: () => void
  stop: () => void
  /**
   * Applies a change to the stored session under the store lock. The producer sees the state the
   * change would land on and returns `undefined` to make it a no-op - which is how a write meant for
   * one session avoids landing on the one that replaced it while the write was waiting for the lock.
   */
  updateSessionState: (update: (state: SessionState) => Partial<SessionState> | undefined) => void
}

/**
 * Every second, the storage will be polled to check for any change that can occur
 * to the session state in another browser tab, or another window.
 * This value has been determined from our previous cookie-only implementation.
 */
export const STORAGE_POLL_DELAY = ONE_SECOND

/**
 * FLASHCAT FORK - how long an anonymous id this page has just generated, or just changed to, must
 * go without a conflict before it is taken as the one every page of this browser shares.
 *
 * localStorage has no lock: pages that start together each find it empty and generate their own
 * id. Chrome also keeps a copy of localStorage per renderer and propagates writes to other pages
 * asynchronously, so a page cannot learn that it lost the race by reading its own write back. Pages
 * converge instead on the smallest id any of them has seen (see `settleAnonymousId`), learning of
 * each other's ids through `storage` events and the poll. This delay has to outlast the
 * propagation of a write between pages.
 */
export const ANONYMOUS_ID_SETTLE_DELAY = 300

/**
 * Selects the correct session store strategy type based on the configuration and storage
 * availability.
 */
export function selectSessionStoreStrategyType(
  initConfiguration: InitConfiguration
): SessionStoreStrategyType | undefined {
  switch (initConfiguration.sessionPersistence) {
    case SessionPersistence.COOKIE:
      return selectCookieStrategy(initConfiguration)

    case SessionPersistence.LOCAL_STORAGE:
      return selectLocalStorageStrategy()

    case undefined: {
      let sessionStoreStrategyType = selectCookieStrategy(initConfiguration)
      if (!sessionStoreStrategyType && initConfiguration.allowFallbackToLocalStorage) {
        sessionStoreStrategyType = selectLocalStorageStrategy()
      }
      return sessionStoreStrategyType
    }

    default:
      display.error(`Invalid session persistence '${String(initConfiguration.sessionPersistence)}'`)
  }
}

/**
 * Different session concepts:
 * - tracked, the session has an id and is updated along the user navigation
 * - not tracked, the session does not have an id but it is updated along the user navigation
 * - inactive, no session in store or session expired, waiting for a renew session
 */
export function startSessionStore<TrackingType extends string>(
  sessionStoreStrategyType: SessionStoreStrategyType,
  configuration: Configuration,
  productKey: string,
  computeSessionState: (rawTrackingType?: string) => { trackingType: TrackingType; isTracked: boolean }
): SessionStore {
  const renewObservable = new Observable<void>()
  const expireObservable = new Observable<void>()
  const sessionStateUpdateObservable = new Observable<{ previousState: SessionState; newState: SessionState }>()

  const sessionStoreStrategy =
    sessionStoreStrategyType.type === SessionPersistence.COOKIE
      ? initCookieStrategy(configuration, sessionStoreStrategyType.cookieOptions)
      : initLocalStorageStrategy(configuration)
  const { expireSession } = sessionStoreStrategy

  const watchSessionTimeoutId = setInterval(watchSession, STORAGE_POLL_DELAY)
  let sessionCache: SessionState

  // FLASHCAT FORK - a cookie is shared and read synchronously by every page, so only localStorage
  // needs pages to agree on the anonymous id. A `storage` event tells this page about another
  // page's write as soon as it propagates, rather than at the next poll.
  const settlesAnonymousId = sessionStoreStrategyType.type === SessionPersistence.LOCAL_STORAGE
  let anonymousIdChangedAt: number | undefined
  const { stop: stopStorageListener } = settlesAnonymousId
    ? addEventListener(configuration, window, DOM_EVENT.STORAGE, (event) => {
        if (event.key === SESSION_STORE_KEY) {
          watchSession()
        }
      })
    : { stop: () => undefined }

  startSession()

  const { throttled: throttledExpandOrRenewSession, cancel: cancelExpandOrRenewSession } = throttle(() => {
    processSessionStoreOperations(
      {
        process: (sessionState) => {
          if (isSessionInNotStartedState(sessionState)) {
            return
          }

          const synchronizedSession = synchronizeSession(sessionState)
          expandOrRenewSessionState(synchronizedSession)
          return synchronizedSession
        },
        after: (sessionState) => {
          if (isSessionStarted(sessionState) && !hasSessionInCache()) {
            renewSessionInCache(sessionState)
          }
          sessionCache = sessionState
        },
      },
      sessionStoreStrategy
    )
  }, STORAGE_POLL_DELAY)

  function expandSession() {
    processSessionStoreOperations(
      {
        process: (sessionState) => (hasSessionInCache() ? synchronizeSession(sessionState) : undefined),
      },
      sessionStoreStrategy
    )
  }

  /**
   * allows two behaviors:
   * - if the session is active, synchronize the session cache without updating the session store
   * - if the session is not active, clear the session store and expire the session cache
   */
  function watchSession() {
    processSessionStoreOperations(
      {
        process: (sessionState) => {
          if (isSessionInExpiredState(sessionState)) {
            return getExpiredSessionState(sessionState, configuration)
          }
          // Storage holding a larger id than this page's must be told: the page that wrote it
          // may not have seen this page's id at all.
          return settleAnonymousId(sessionState) ? sessionState : undefined
        },
        after: synchronizeSession,
      },
      sessionStoreStrategy
    )
  }

  function synchronizeSession(sessionState: SessionState) {
    if (isSessionInExpiredState(sessionState)) {
      sessionState = getExpiredSessionState(sessionState, configuration)
    }
    settleAnonymousId(sessionState)
    if (hasSessionInCache()) {
      if (isSessionInCacheOutdated(sessionState)) {
        expireSessionInCache()
      } else {
        sessionStateUpdateObservable.notify({ previousState: sessionCache, newState: sessionState })
        sessionCache = sessionState
      }
    }
    return sessionState
  }

  function startSession() {
    processSessionStoreOperations(
      {
        process: (sessionState) => {
          if (isSessionInNotStartedState(sessionState)) {
            const startedSessionState = getExpiredSessionState(sessionState, configuration)
            if (settlesAnonymousId && !sessionState.anonymousId && startedSessionState.anonymousId) {
              anonymousIdChangedAt = dateNow()
            }
            return startedSessionState
          }
        },
        after: (sessionState) => {
          sessionCache = sessionState
        },
      },
      sessionStoreStrategy
    )
  }

  function expandOrRenewSessionState(sessionState: SessionState) {
    if (isSessionInNotStartedState(sessionState)) {
      return false
    }

    const { trackingType, isTracked } = computeSessionState(sessionState[productKey])
    sessionState[productKey] = trackingType
    delete sessionState.isExpired
    if (isTracked && !sessionState.id) {
      sessionState.id = generateUUID()
    }
    // Stamp every started session, tracked or not. The creation date is what caps a session at
    // SESSION_TIME_OUT_DELAY, and a not-tracked session that carried none would be held open
    // indefinitely by the visibility timer refreshing `expire` -- the same escape this change
    // closes for tracked sessions, left open for the sampled-out half. Without the cap those
    // users never get to re-roll the sampling decision.
    if (!sessionState.created) {
      sessionState.created = String(dateNow())
    }
    // Stamp the deadline before returning. The caller decides whether the session is expired
    // straight after this runs and only stamps it afterwards, so a session renewed here would be
    // judged with no deadline at all -- which now reads as expired and would stop any session
    // from ever establishing. Upstream does the same inside its own expandOrRenew.
    expandSessionState(sessionState)
  }

  /**
   * FLASHCAT FORK - gives `sessionState` the smallest of its anonymous id and this page's, a rule
   * every page applies the same way so all of them end on one id whatever order their writes
   * reach each other in. Returns whether `sessionState` changed, i.e. storage is behind this page.
   */
  function settleAnonymousId(sessionState: SessionState) {
    const cachedId = sessionCache.anonymousId
    const storedId = sessionState.anonymousId
    if (!settlesAnonymousId || !cachedId || !storedId || cachedId === storedId) {
      return false
    }
    anonymousIdChangedAt = dateNow()
    if (cachedId < storedId) {
      sessionState.anonymousId = cachedId
      return true
    }
    return false
  }

  function hasSessionInCache() {
    return sessionCache[productKey] !== undefined
  }

  function isSessionInCacheOutdated(sessionState: SessionState) {
    return sessionCache.id !== sessionState.id || sessionCache[productKey] !== sessionState[productKey]
  }

  function expireSessionInCache() {
    sessionCache = getExpiredSessionState(sessionCache, configuration)
    expireObservable.notify()
  }

  function renewSessionInCache(sessionState: SessionState) {
    sessionCache = sessionState
    renewObservable.notify()
  }

  function updateSessionState(update: (state: SessionState) => Partial<SessionState> | undefined) {
    processSessionStoreOperations(
      {
        process: (sessionState) => {
          const partialSessionState = update(sessionState)
          return partialSessionState && { ...sessionState, ...partialSessionState }
        },
        after: synchronizeSession,
      },
      sessionStoreStrategy
    )
  }

  return {
    expandOrRenewSession: throttledExpandOrRenewSession,
    expandSession,
    getSession: () => sessionCache,
    isAnonymousIdSettling: () =>
      anonymousIdChangedAt !== undefined && dateNow() - anonymousIdChangedAt < ANONYMOUS_ID_SETTLE_DELAY,
    renewObservable,
    expireObservable,
    sessionStateUpdateObservable,
    restartSession: startSession,
    expire: () => {
      cancelExpandOrRenewSession()
      expireSession(sessionCache)
      synchronizeSession(getExpiredSessionState(sessionCache, configuration))
    },
    stop: () => {
      clearInterval(watchSessionTimeoutId)
      stopStorageListener()
    },
    updateSessionState,
  }
}
