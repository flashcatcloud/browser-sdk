import { isEmptyObject } from '../../tools/utils/objectUtils'
import { objectEntries } from '../../tools/utils/polyfills'
import { dateNow } from '../../tools/utils/timeUtils'
import { generateUUID } from '../../tools/utils/stringUtils'
import type { Configuration } from '../configuration'
import { SESSION_EXPIRATION_DELAY, SESSION_TIME_OUT_DELAY } from './sessionConstants'
import { isValidSessionString, SESSION_ENTRY_REGEXP, SESSION_ENTRY_SEPARATOR } from './sessionStateValidation'
export const EXPIRED = '1'

export interface SessionState {
  id?: string
  created?: string
  expire?: string
  isExpired?: typeof EXPIRED

  [key: string]: string | undefined
}

export function getExpiredSessionState(
  previousSessionState: SessionState | undefined,
  configuration: Configuration
): SessionState {
  const expiredSessionState: SessionState = {
    isExpired: EXPIRED,
  }
  if (configuration.trackAnonymousUser) {
    if (previousSessionState?.anonymousId) {
      expiredSessionState.anonymousId = previousSessionState?.anonymousId
    } else {
      expiredSessionState.anonymousId = generateUUID()
    }
  }
  return expiredSessionState
}

export function isSessionInNotStartedState(session: SessionState) {
  return isEmptyObject(session)
}

export function isSessionStarted(session: SessionState) {
  return !isSessionInNotStartedState(session)
}

/**
 * The moment the session actually stops being usable: whichever comes first, the sliding
 * inactivity deadline or the hard cap counted from when the session was created.
 *
 * Returns undefined when either stamp is missing, which callers treat as "expired". A session
 * that cannot say when it started or when it lapses is not given the benefit of the doubt --
 * letting `undefined` short-circuit those comparisons is what allowed sessions to outlive both
 * bounds and stay alive for days on a page that was never closed.
 *
 * Ported from upstream DataDog/browser-sdk 5257b52ea ("fix session lifetime bugs for long-lived
 * pages and multi-tab scenarios", #4531); their SessionManager rewrite makes the commit itself
 * unmergeable here, so only the rule is carried over.
 */
export function getExpireDate(state: SessionState): number | undefined {
  const expireDate = state.expire && Number(state.expire)
  if (!expireDate) {
    return
  }
  const createdDate = state.created && Number(state.created)
  if (createdDate) {
    return Math.min(expireDate, createdDate + SESSION_TIME_OUT_DELAY)
  }
  // Every session this bundle starts is stamped, so a missing creation date means the state was
  // written elsewhere: either by a build that predates the stamp, or by another bundle sharing the
  // cookie. A state holding an id is judged strictly -- it cannot be shown to sit inside the cap.
  // One without an id is not tracked, carries no identity, and falls back to `expire` alone rather
  // than being expired on sight, which would make old and new builds fight over the same cookie.
  return state.id === undefined ? expireDate : undefined
}

export function isSessionInExpiredState(session: SessionState) {
  if (isSessionInNotStartedState(session)) {
    // nothing has been stored yet, so there is no session to consider expired
    return false
  }
  return session.isExpired !== undefined || !isActiveSession(session)
}

// An active session is a session in either `Tracked` or `NotTracked` state
function isActiveSession(sessionState: SessionState) {
  const expireDate = getExpireDate(sessionState)
  return expireDate ? dateNow() < expireDate : false
}

export function expandSessionState(session: SessionState) {
  session.expire = String(dateNow() + SESSION_EXPIRATION_DELAY)
}

export function toSessionString(session: SessionState) {
  return (
    objectEntries(session)
      // we use `aid` as a key for anonymousId
      .map(([key, value]) => (key === 'anonymousId' ? `aid=${value}` : `${key}=${value}`))
      .join(SESSION_ENTRY_SEPARATOR)
  )
}

export function toSessionState(sessionString: string | undefined | null) {
  const session: SessionState = {}
  if (isValidSessionString(sessionString)) {
    sessionString.split(SESSION_ENTRY_SEPARATOR).forEach((entry) => {
      const matches = SESSION_ENTRY_REGEXP.exec(entry)
      if (matches !== null) {
        const [, key, value] = matches
        if (key === 'aid') {
          // we use `aid` as a key for anonymousId
          session.anonymousId = value
        } else {
          session[key] = value
        }
      }
    })
  }
  return session
}
