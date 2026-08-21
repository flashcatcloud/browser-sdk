import { dateNow } from '../tools/timeUtils'
import { generateUUID } from '../transport/intakeUrl'

/**
 * Session identity is shared with the modern bundle: same cookie name, same serialisation, same
 * expiration rules. A page that loads the legacy build on one visit and the modern build on the
 * next keeps the same session, and the intake sees one consistent format.
 */
export const SESSION_COOKIE_NAME = '_dd_s'

const ONE_MINUTE = 60 * 1000
const ONE_HOUR = 60 * ONE_MINUTE

/** Time without activity after which the session ends. */
const SESSION_EXPIRATION_DELAY = 15 * ONE_MINUTE
/** Hard cap on a session's lifetime, however active it is. */
const SESSION_TIME_OUT_DELAY = 4 * ONE_HOUR

/** Tracking decision, stored in the cookie using the same values as the modern bundle. */
/** The modern bundle's marker for a session that has ended. */
const EXPIRED = '1'
const NOT_TRACKED = '0'
const TRACKED_WITH_SESSION_REPLAY = '1'
const TRACKED_WITHOUT_SESSION_REPLAY = '2'

/**
 * How long a session may be reused without touching the cookie again.
 *
 * The session is looked up for every event, and reading and writing document.cookie is a full
 * string parse each time. On the browsers this build targets that cost is worth avoiding, and the
 * modern bundle throttles the same operation over the same window.
 */
export const COOKIE_ACCESS_DELAY = 1000

export interface LegacySession {
  id: string
  isTracked: boolean
}

interface SessionState {
  id?: string
  created?: string
  expire?: string
  rum?: string
  // The standard bundles keep their own entries in this cookie, the anonymous user id among them.
  [key: string]: string | undefined
}

export function createSessionStore(sessionSampleRate: number) {
  // Kept in memory as well as in the cookie so that a page which cannot persist cookies still
  // reports a stable session for the lifetime of the document.
  let inMemoryState: SessionState | undefined
  let lastCookieAccess: number | undefined

  return {
    /**
     * Ends the current session without stopping anything. The next event draws a fresh session,
     * with a fresh sampling decision, exactly as the modern bundle does when a session expires.
     *
     * The in-memory copy and the throttle timestamp go with the cookie: leaving either behind
     * would keep handing out the session that just ended for up to the throttle window.
     */
    expire(): void {
      inMemoryState = undefined
      lastCookieAccess = undefined
      // Written rather than deleted, in the shape the modern bundle writes for an expired session:
      // the entries that outlive a session — the anonymous user id among them — are kept, and the
      // next event here draws a new session because there is no tracking decision left.
      const expired = extractForeignFields(readSessionCookie())
      expired.isExpired = EXPIRED
      writeSessionCookie(expired)
    },

    getOrCreateSession(): LegacySession {
      const now = dateNow()

      // A backwards clock correction makes the elapsed time negative, which would otherwise read as
      // "still inside the window" and freeze the session until the clock caught up.
      const sinceLastAccess = lastCookieAccess === undefined ? undefined : now - lastCookieAccess
      if (
        inMemoryState &&
        sinceLastAccess !== undefined &&
        sinceLastAccess >= 0 &&
        sinceLastAccess < COOKIE_ACCESS_DELAY
      ) {
        return toSession(inMemoryState)
      }

      let state = readSessionCookie() || inMemoryState

      // An id-less cookie is not an invalid one. The modern bundle only mints an id once a session
      // is tracked, so `rum=0` with no id is what a legitimately sampled-out session looks like.
      // Renewing on a missing id would re-run the draw on a session that has already been sampled
      // out, which is the one thing sessionSampleRate promises not to do.
      if (!state || !state.rum || isExpired(state, now)) {
        // Entries this build does not understand — the anonymous user id among them — belong to the
        // user rather than to the session, and outlive the session they were found on.
        state = extractForeignFields(state)
        state.created = String(now)
        // Decided once, when the session starts, and carried in the cookie from then on. Rolling
        // it per event would send a fraction of the events of every session instead of all the
        // events of a fraction of the sessions.
        state.rum = Math.random() * 100 < sessionSampleRate ? TRACKED_WITHOUT_SESSION_REPLAY : NOT_TRACKED
      }

      if (isTracked(state) && !state.id) {
        state.id = generateUUID()
      }

      state.expire = String(now + SESSION_EXPIRATION_DELAY)
      inMemoryState = state
      lastCookieAccess = now
      writeSessionCookie(state)

      return toSession(state)
    },
  }
}

function toSession(state: SessionState): LegacySession {
  // Both tracked values count. This build never writes '1' itself, but both builds share one cookie
  // jar per domain, and IE enterprise site lists routinely put some urls of a site in compatibility
  // mode and others not. Reading a session the modern bundle started as untracked would silence
  // this one for the rest of that session's lifetime.
  return {
    id: state.id!,
    isTracked: isTracked(state),
  }
}

function isTracked(state: SessionState): boolean {
  return state.rum === TRACKED_WITHOUT_SESSION_REPLAY || state.rum === TRACKED_WITH_SESSION_REPLAY
}

/**
 * Keeps the entries of a state that this build does not own, dropping the session's own fields.
 * Used when a session is renewed: the new session is a different session, but the user behind it
 * is the same one.
 */
function extractForeignFields(state: SessionState | undefined): SessionState {
  const kept: SessionState = {}
  if (!state) {
    return kept
  }
  for (const key in state) {
    if (Object.prototype.hasOwnProperty.call(state, key) && KNOWN_FIELDS.indexOf(key) === -1 && state[key]) {
      kept[key] = state[key]
    }
  }
  return kept
}

function isExpired(state: SessionState, now: number): boolean {
  const createdAt = Number(state.created)
  const expiresAt = Number(state.expire)
  return (createdAt && now - createdAt >= SESSION_TIME_OUT_DELAY) || (expiresAt && now >= expiresAt) ? true : false
}

/**
 * Serialisation has to match the modern bundle's parser, whose entry pattern is
 * /^([a-zA-Z]+)=([a-z0-9-]+)$/. Uppercase characters or padding would make it discard the whole
 * cookie, silently restarting the session on every page load.
 */
// `isExpired` belongs to the modern bundle's vocabulary, not to ours, but it has to be listed here
// all the same: carried forward as an unknown field it would mark every session this build writes
// as expired, and the modern bundle would start a new one on every page load.
const KNOWN_FIELDS = ['id', 'created', 'expire', 'rum', 'isExpired']

function serialize(state: SessionState): string {
  const entries: string[] = []

  for (let i = 0; i < KNOWN_FIELDS.length; i++) {
    const value = state[KNOWN_FIELDS[i]]
    if (value) {
      entries.push(`${KNOWN_FIELDS[i]}=${value}`)
    }
  }

  // Anything else found in the cookie is written back untouched. The standard bundles keep their
  // own entries here, the anonymous user id among them, and dropping one would reset it for them.
  // Values reaching this point already passed the entry pattern when they were parsed.
  for (const key in state) {
    if (Object.prototype.hasOwnProperty.call(state, key) && KNOWN_FIELDS.indexOf(key) === -1 && state[key]) {
      entries.push(`${key}=${state[key]}`)
    }
  }

  return entries.join('&')
}

function deserialize(value: string): SessionState | undefined {
  const state: SessionState = {}
  const entries = value.split('&')
  for (let i = 0; i < entries.length; i++) {
    const match = /^([a-zA-Z]+)=([a-z0-9-]+)$/.exec(entries[i])
    if (match) {
      state[match[1]] = match[2]
    }
  }
  /*
   * Any entry that parsed is enough. An untracked session has no id, and the state the modern
   * bundle writes when a session expires has neither an id nor a tracking decision — it is
   * `isExpired=1` next to the anonymous user id it deliberately carries across the expiry.
   * Requiring one of our own fields here threw that cookie away and reset an identifier the other
   * build was keeping.
   */
  for (const key in state) {
    if (Object.prototype.hasOwnProperty.call(state, key)) {
      return state
    }
  }
  return undefined
}

function readSessionCookie(): SessionState | undefined {
  const match = new RegExp(`(?:^|;)\\s*${SESSION_COOKIE_NAME}\\s*=\\s*([^;]+)`).exec(document.cookie)
  if (!match) {
    return undefined
  }
  try {
    return deserialize(decodeURIComponent(match[1]))
  } catch {
    return undefined
  }
}

function writeSessionCookie(state: SessionState): void {
  const expires = new Date(dateNow() + SESSION_EXPIRATION_DELAY).toUTCString()
  // Written raw, not percent-encoded: the modern bundle reads this cookie without decoding it, and
  // an encoded value fails its validation, so the session would be dropped instead of shared. The
  // serialized value is already constrained to characters that are legal in a cookie value.
  document.cookie = `${SESSION_COOKIE_NAME}=${serialize(state)};expires=${expires};path=/;samesite=strict`
}

export function deleteSessionCookie(): void {
  document.cookie = `${SESSION_COOKIE_NAME}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`
}
