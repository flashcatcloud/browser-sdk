import { isValidSessionString } from '../../../core/src/domain/session/sessionStateValidation'
import { toSessionState } from '../../../core/src/domain/session/sessionState'
import { SESSION_COOKIE_NAME, createSessionStore, deleteSessionCookie } from './sessionStore'

/**
 * The cookie written here is the same one the modern bundle reads, so its format is not ours to
 * choose. These specs validate what we write with the modern parser rather than with a
 * hand-written expectation.
 */
describe('session store', () => {
  const ONE_MINUTE = 60 * 1000

  function readRawCookie(): string | undefined {
    const match = new RegExp(`(?:^|;)\\s*${SESSION_COOKIE_NAME}\\s*=\\s*([^;]+)`).exec(document.cookie)
    return match ? decodeURIComponent(match[1]) : undefined
  }

  afterEach(() => {
    deleteSessionCookie()
  })

  it('creates a session with a lowercase uuid', () => {
    const session = createSessionStore().getOrCreateSession()

    expect(session.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('writes a cookie the modern bundle considers valid', () => {
    createSessionStore().getOrCreateSession()

    expect(isValidSessionString(readRawCookie())).toBe(true)
  })

  it('writes the fields the modern bundle expects to find', () => {
    const session = createSessionStore().getOrCreateSession()

    const state = toSessionState(readRawCookie())
    expect(state.id).toBe(session.id)
    // '2' means tracked without session replay, which is all this build can offer.
    expect(state.rum).toBe('2')
    expect(Number(state.created)).toBeGreaterThan(0)
    expect(Number(state.expire)).toBeGreaterThan(Date.now())
  })

  it('reuses the session across calls', () => {
    const store = createSessionStore()

    expect(store.getOrCreateSession().id).toBe(store.getOrCreateSession().id)
  })

  it('reuses a session written by a previous page load', () => {
    const first = createSessionStore().getOrCreateSession()

    expect(createSessionStore().getOrCreateSession().id).toBe(first.id)
  })

  it('pushes the expiration forward on activity', () => {
    const store = createSessionStore()
    store.getOrCreateSession()
    const firstExpire = Number(toSessionState(readRawCookie()).expire)

    jasmine.clock().install()
    jasmine.clock().mockDate(new Date(Date.now() + ONE_MINUTE))
    store.getOrCreateSession()
    const secondExpire = Number(toSessionState(readRawCookie()).expire)
    jasmine.clock().uninstall()

    expect(secondExpire).toBeGreaterThan(firstExpire)
  })

  it('starts a new session once the inactivity window has passed', () => {
    const first = createSessionStore().getOrCreateSession()

    jasmine.clock().install()
    jasmine.clock().mockDate(new Date(Date.now() + 16 * ONE_MINUTE))
    const second = createSessionStore().getOrCreateSession()
    jasmine.clock().uninstall()

    expect(second.id).not.toBe(first.id)
  })

  it('starts a new session once the maximum duration has passed', () => {
    const first = createSessionStore().getOrCreateSession()

    jasmine.clock().install()
    // Still inside the inactivity window, but past the 4 hour cap.
    jasmine.clock().mockDate(new Date(Date.now() + 4 * 60 * ONE_MINUTE + ONE_MINUTE))
    const store = createSessionStore()
    const second = store.getOrCreateSession()
    jasmine.clock().uninstall()

    expect(second.id).not.toBe(first.id)
  })

  it('keeps working when the cookie cannot be persisted', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!
    Object.defineProperty(document, 'cookie', { get: () => '', set: () => undefined, configurable: true })

    const session = createSessionStore().getOrCreateSession()

    Object.defineProperty(document, 'cookie', descriptor)

    expect(session.id).toMatch(/^[0-9a-f-]{36}$/)
  })
})
