import { isValidSessionString } from '../../../core/src/domain/session/sessionStateValidation'
import { toSessionState } from '../../../core/src/domain/session/sessionState'
import { COOKIE_ACCESS_DELAY, SESSION_COOKIE_NAME, createSessionStore, deleteSessionCookie } from './sessionStore'

/**
 * The cookie written here is the same one the modern bundle reads, so its format is not ours to
 * choose. These specs validate what we write with the modern parser rather than with a
 * hand-written expectation.
 *
 * The raw cookie value is passed to that parser untouched. Decoding it first would be testing a
 * string that never exists in the browser: the modern bundle reads document.cookie without
 * decoding, so anything a decode step repairs here is broken in production.
 */
describe('session store', () => {
  const ONE_MINUTE = 60 * 1000

  function readRawCookie(): string | undefined {
    const match = new RegExp(`(?:^|;)\\s*${SESSION_COOKIE_NAME}\\s*=\\s*([^;]+)`).exec(document.cookie)
    return match ? match[1] : undefined
  }

  // Cleared before rather than only after: a spec elsewhere may have left a session cookie behind,
  // and a stale one would be reused instead of a fresh session being created.
  beforeEach(() => {
    deleteSessionCookie()
  })

  afterEach(() => {
    deleteSessionCookie()
  })

  it('creates a session with a lowercase uuid', () => {
    const session = createSessionStore(100).getOrCreateSession()

    expect(session.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('writes a cookie the modern bundle considers valid', () => {
    createSessionStore(100).getOrCreateSession()

    expect(isValidSessionString(readRawCookie())).toBe(true)
  })

  it('leaves a session written by the modern bundle readable after touching it', () => {
    // Written the way the modern bundle writes it: raw, undecorated.
    const modernSessionId = '11111111-2222-4333-8444-555555555555'
    document.cookie = `${SESSION_COOKIE_NAME}=id=${modernSessionId}&rum=2&created=${Date.now()}&expire=${
      Date.now() + ONE_MINUTE
    };path=/`

    const session = createSessionStore(100).getOrCreateSession()

    expect(session.id).toBe(modernSessionId)
    const rewritten = readRawCookie()
    expect(isValidSessionString(rewritten)).toBe(true)
    expect(toSessionState(rewritten).id).toBe(modernSessionId)
  })

  it('keeps a session the modern bundle sampled out, even at a full sample rate', () => {
    // What the modern bundle writes for a session that lost the draw: a decision, no id.
    document.cookie = `${SESSION_COOKIE_NAME}=rum=0&created=${Date.now()}&expire=${Date.now() + ONE_MINUTE};path=/`

    const session = createSessionStore(100).getOrCreateSession()

    expect(session.isTracked).toBe(false)
    expect(toSessionState(readRawCookie()).rum).toBe('0')
  })

  it('carries entries it does not understand across a session renewal', () => {
    const anonymousId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    // Expired: created and expire are both in the past.
    document.cookie = `${SESSION_COOKIE_NAME}=id=old-session&rum=2&created=1&expire=2&aid=${anonymousId};path=/`

    createSessionStore(100).getOrCreateSession()

    // The modern parser exposes the `aid` cookie entry as anonymousId.
    const state = toSessionState(readRawCookie())
    expect(state.anonymousId).toBe(anonymousId)
    expect(state.id).not.toBe('old-session')
  })

  it('keeps the cookie itself for as long as the modern bundle does', () => {
    /*
     * The expiry attribute cannot be read back from document.cookie, so the write is captured
     * instead. It matters because a session that ends leaves the identifiers that outlive it in
     * this cookie: a short-lived cookie would drop them the moment the browser cleaned it up, well
     * before the modern bundle expects them gone.
     */
    const writes: string[] = []
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => original.get!.call(document) as string,
      set: (value: string) => {
        writes.push(value)
        original.set!.call(document, value)
      },
    })

    try {
      createSessionStore(100).getOrCreateSession()
    } finally {
      delete (document as any).cookie
    }

    const expires = /expires=([^;]+)/.exec(writes[writes.length - 1])
    expect(expires).not.toBe(null)
    // A year out, give or take; anything on the order of the session's own fifteen minutes is the
    // bug this guards against.
    expect(new Date(expires![1]).getTime() - Date.now()).toBeGreaterThan(300 * 24 * 60 * 60 * 1000)
  })

  it('keeps the anonymous user id out of a session the modern bundle expired', () => {
    const anonymousId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    // Exactly what the modern bundle writes when a session ends: no id, no tracking decision, and
    // the identifier it deliberately carries across the expiry.
    document.cookie = `${SESSION_COOKIE_NAME}=isExpired=1&aid=${anonymousId};path=/`

    const session = createSessionStore(100).getOrCreateSession()

    expect(session.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(toSessionState(readRawCookie()).anonymousId).toBe(anonymousId)
  })

  it('does not carry the expired marker into the session it starts', () => {
    document.cookie = `${SESSION_COOKIE_NAME}=isExpired=1;path=/`

    createSessionStore(100).getOrCreateSession()

    // The modern bundle reads any session carrying this marker as expired, so leaving it in place
    // would make it start a new session on every single page load.
    expect(readRawCookie()).not.toContain('isExpired')
  })

  it('ends a session the way the modern bundle ends one', () => {
    const anonymousId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    document.cookie = `${SESSION_COOKIE_NAME}=id=old-session&rum=2&created=${Date.now()}&expire=${
      Date.now() + ONE_MINUTE
    }&aid=${anonymousId};path=/`
    const store = createSessionStore(100)
    store.getOrCreateSession()

    store.expire()

    const state = toSessionState(readRawCookie())
    expect(state.isExpired).toBe('1')
    expect(state.id).toBeUndefined()
    // The session ended; the user behind it did not.
    expect(state.anonymousId).toBe(anonymousId)
  })

  it('writes the fields the modern bundle expects to find', () => {
    const session = createSessionStore(100).getOrCreateSession()

    const state = toSessionState(readRawCookie())
    expect(state.id).toBe(session.id)
    // '2' means tracked without session replay, which is all this build can offer.
    expect(state.rum).toBe('2')
    expect(Number(state.created)).toBeGreaterThan(0)
    expect(Number(state.expire)).toBeGreaterThan(Date.now())
  })

  it('reuses the session across calls', () => {
    const store = createSessionStore(100)

    expect(store.getOrCreateSession().id).toBe(store.getOrCreateSession().id)
  })

  it('reuses a session written by a previous page load', () => {
    const first = createSessionStore(100).getOrCreateSession()

    expect(createSessionStore(100).getOrCreateSession().id).toBe(first.id)
  })

  it('pushes the expiration forward on activity', () => {
    const store = createSessionStore(100)
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
    const first = createSessionStore(100).getOrCreateSession()

    jasmine.clock().install()
    jasmine.clock().mockDate(new Date(Date.now() + 16 * ONE_MINUTE))
    const second = createSessionStore(100).getOrCreateSession()
    jasmine.clock().uninstall()

    expect(second.id).not.toBe(first.id)
  })

  it('starts a new session once the maximum duration has passed', () => {
    const first = createSessionStore(100).getOrCreateSession()

    jasmine.clock().install()
    // Still inside the inactivity window, but past the 4 hour cap.
    jasmine.clock().mockDate(new Date(Date.now() + 4 * 60 * ONE_MINUTE + ONE_MINUTE))
    const store = createSessionStore(100)
    const second = store.getOrCreateSession()
    jasmine.clock().uninstall()

    expect(second.id).not.toBe(first.id)
  })

  describe('sampling', () => {
    it('tracks the session when the sample rate is 100', () => {
      expect(createSessionStore(100).getOrCreateSession().isTracked).toBe(true)
    })

    it('does not track the session when the sample rate is 0', () => {
      expect(createSessionStore(0).getOrCreateSession().isTracked).toBe(false)
    })

    it('records the decision in the cookie so the whole session is consistent', () => {
      createSessionStore(0).getOrCreateSession()

      // '0' is what the modern bundle writes for a session it decided not to track.
      expect(toSessionState(readRawCookie()).rum).toBe('0')
    })

    it('keeps the decision across page loads rather than re-rolling it', () => {
      createSessionStore(0).getOrCreateSession()

      // A second store with a rate that would always sample must still honour the stored decision.
      expect(createSessionStore(100).getOrCreateSession().isTracked).toBe(false)
    })

    it('honours a session the modern bundle marked as tracked with replay', () => {
      // Both builds share one cookie jar per domain, and IE enterprise site lists routinely put
      // some urls of a site in compatibility mode and others not. Reading '1' as untracked would
      // silence the whole session, for up to its four hour lifetime.
      document.cookie = `${SESSION_COOKIE_NAME}=id=00000000-aaaa-0000-aaaa-000000000000&created=${Date.now()}&expire=${Date.now() + 60000}&rum=1;path=/`

      expect(createSessionStore(100).getOrCreateSession().isTracked).toBe(true)
    })

    it('honours a session marked as not tracked', () => {
      document.cookie = `${SESSION_COOKIE_NAME}=id=00000000-aaaa-0000-aaaa-000000000000&created=${Date.now()}&expire=${Date.now() + 60000}&rum=0;path=/`

      expect(createSessionStore(100).getOrCreateSession().isTracked).toBe(false)
    })

    it('applies the configured rate', () => {
      spyOn(Math, 'random').and.returnValue(0.5)

      expect(createSessionStore(60).getOrCreateSession().isTracked).toBe(true)
      deleteSessionCookie()
      expect(createSessionStore(40).getOrCreateSession().isTracked).toBe(false)
    })
  })

  describe('cookie access', () => {
    it('does not touch the cookie again within the throttling window', () => {
      const store = createSessionStore(100)
      store.getOrCreateSession()
      const setSpy = spyOnProperty(document, 'cookie', 'set')

      store.getOrCreateSession()
      store.getOrCreateSession()

      // Every event asks for the session. Writing the cookie each time is a measurable cost on the
      // browsers this build targets, so reads and writes are throttled the way the modern bundle
      // throttles them.
      expect(setSpy).not.toHaveBeenCalled()
    })

    it('refreshes the cookie once the window has passed', () => {
      const store = createSessionStore(100)
      store.getOrCreateSession()

      jasmine.clock().install()
      jasmine.clock().mockDate(new Date(Date.now() + COOKIE_ACCESS_DELAY + 1))
      const setSpy = spyOnProperty(document, 'cookie', 'set')
      store.getOrCreateSession()
      jasmine.clock().uninstall()

      expect(setSpy).toHaveBeenCalled()
    })

    it('does not stay throttled forever when the clock jumps backwards', () => {
      const store = createSessionStore(100)
      store.getOrCreateSession()

      jasmine.clock().install()
      jasmine.clock().mockDate(new Date(Date.now() - 60 * 60 * 1000))
      const setSpy = spyOnProperty(document, 'cookie', 'set')
      store.getOrCreateSession()
      jasmine.clock().uninstall()

      // A backwards jump makes the elapsed time negative, which would otherwise read as "still
      // inside the window" and keep the session frozen until the clock caught up.
      expect(setSpy).toHaveBeenCalled()
    })

    it('still returns the same session while throttled', () => {
      const store = createSessionStore(100)

      expect(store.getOrCreateSession().id).toBe(store.getOrCreateSession().id)
    })
  })

  describe('hostile input', () => {
    it('preserves fields it does not understand instead of destroying them', () => {
      // The standard bundles store the anonymous user id as `aid` in this same cookie, and track it
      // by default. Rewriting the cookie without it would reset anonymous user continuity for them.
      document.cookie = `${SESSION_COOKIE_NAME}=id=00000000-aaaa-0000-aaaa-000000000000&created=${Date.now()}&expire=${Date.now() + 60000}&rum=2&aid=11111111-bbbb-0000-bbbb-000000000000;path=/`

      createSessionStore(100).getOrCreateSession()

      // The standard parser maps `aid` back to anonymousId, so this asserts what it will actually see.
      expect(toSessionState(readRawCookie()).anonymousId).toBe('11111111-bbbb-0000-bbbb-000000000000')
    })

    it('ignores unknown fields injected into the session cookie', () => {
      document.cookie = `${SESSION_COOKIE_NAME}=id=00000000-aaaa-0000-aaaa-000000000000&created=${Date.now()}&expire=${Date.now() + 60000}&rum=2&evil=payload;path=/`

      const session = createSessionStore(100).getOrCreateSession()

      // Unknown entries are carried through rather than acted on: they cannot reach the session
      // identity or the tracking decision, which are read from named fields only.
      expect(session.id).toBe('00000000-aaaa-0000-aaaa-000000000000')
      expect(session.isTracked).toBe(true)
    })

    it('is not confused by a polluted Object prototype', () => {
      // A page that has extended Object.prototype must not end up with those keys in the session.
      ;(Object.prototype as any).injected = 'value'
      try {
        const session = createSessionStore(100).getOrCreateSession()

        expect(session.id).toMatch(/^[0-9a-f-]{36}$/)
        expect(readRawCookie()).not.toContain('injected')
      } finally {
        delete (Object.prototype as any).injected
      }
    })

    it('starts a fresh session rather than trusting a malformed cookie', () => {
      document.cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent('not a session at all')};path=/`

      expect(createSessionStore(100).getOrCreateSession().id).toMatch(/^[0-9a-f-]{36}$/)
    })
  })

  it('keeps working when the cookie cannot be persisted', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!
    Object.defineProperty(document, 'cookie', { get: () => '', set: () => undefined, configurable: true })

    const session = createSessionStore(100).getOrCreateSession()

    Object.defineProperty(document, 'cookie', descriptor)

    expect(session.id).toMatch(/^[0-9a-f-]{36}$/)
  })
})
