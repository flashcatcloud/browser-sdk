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

/** '2' is "tracked, without session replay", the only state this build can be in. */
const TRACKED_WITHOUT_SESSION_REPLAY = '2'

export interface LegacySession {
  id: string
}

interface SessionState {
  id?: string
  created?: string
  expire?: string
  rum?: string
}

export function createSessionStore() {
  // Kept in memory as well as in the cookie so that a page which cannot persist cookies still
  // reports a stable session for the lifetime of the document.
  let inMemoryState: SessionState | undefined

  return {
    getOrCreateSession(): LegacySession {
      const now = dateNow()
      let state = readSessionCookie() || inMemoryState

      if (!state || !state.id || isExpired(state, now)) {
        state = {
          id: generateUUID(),
          created: String(now),
          rum: TRACKED_WITHOUT_SESSION_REPLAY,
        }
      }

      state.expire = String(now + SESSION_EXPIRATION_DELAY)
      inMemoryState = state
      writeSessionCookie(state)

      return { id: state.id! }
    },
  }
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
function serialize(state: SessionState): string {
  const entries: string[] = []
  if (state.id) {
    entries.push(`id=${state.id}`)
  }
  if (state.created) {
    entries.push(`created=${state.created}`)
  }
  if (state.expire) {
    entries.push(`expire=${state.expire}`)
  }
  if (state.rum) {
    entries.push(`rum=${state.rum}`)
  }
  return entries.join('&')
}

function deserialize(value: string): SessionState | undefined {
  const state: SessionState = {}
  const entries = value.split('&')
  for (let i = 0; i < entries.length; i++) {
    const match = /^([a-zA-Z]+)=([a-z0-9-]+)$/.exec(entries[i])
    if (match) {
      state[match[1] as keyof SessionState] = match[2]
    }
  }
  return state.id ? state : undefined
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
  document.cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(serialize(state))};expires=${expires};path=/;samesite=strict`
}

export function deleteSessionCookie(): void {
  document.cookie = `${SESSION_COOKIE_NAME}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`
}
