import { INTAKE_SITE_US1, ONE_SECOND, display, isIntakeUrl } from '@flashcatcloud/browser-core'
import type { Clock, MockXhr } from '@flashcatcloud/browser-core/test'
import { interceptRequests, mockClock, registerCleanupTask } from '@flashcatcloud/browser-core/test'
import { mockRumConfiguration } from '../../../test'
import { LifeCycle, LifeCycleEventType } from '../lifeCycle'
import type { RumConfiguration, RumInitConfiguration } from './configuration'
import {
  buildDrawStoreKey,
  buildRemoteConfigSetup,
  readRemoteConfig,
  startRemoteConfiguration,
} from './remoteConfiguration'

const INIT_CONFIGURATION = {
  clientToken: 'token',
  applicationId: 'app',
  site: INTAKE_SITE_US1,
  env: 'staging',
  version: '1.2.3',
  remoteConfigurationEnabled: true,
} as RumInitConfiguration

function configurationWith(partial: Partial<RumConfiguration> = {}) {
  return mockRumConfiguration({
    sessionSampleRate: 10,
    sessionReplaySampleRate: 20,
    remoteConfig: buildRemoteConfigSetup(INIT_CONFIGURATION),
    ...partial,
  })
}

function body({
  rum = {} as Record<string, unknown>,
  enabled = true,
  custom = undefined as Record<string, unknown> | undefined,
  schemaVersion = 1 as number | undefined,
  version = 3,
} = {}) {
  return JSON.stringify({
    schema_version: schemaVersion,
    version,
    ttl: 600,
    enabled,
    activation: 'next_session',
    rum,
    custom,
  })
}

describe('remoteConfiguration', () => {
  let interceptor: ReturnType<typeof interceptRequests>
  let setup: ReturnType<typeof buildRemoteConfigSetup>
  let lifeCycle: LifeCycle

  beforeEach(() => {
    interceptor = interceptRequests()
    setup = buildRemoteConfigSetup(INIT_CONFIGURATION)
    lifeCycle = new LifeCycle()
    registerCleanupTask(() => localStorage.removeItem(setup!.storeKey))
  })

  function start(configuration: RumConfiguration) {
    const stop = startRemoteConfiguration(configuration, lifeCycle)
    registerCleanupTask(stop)
    return stop
  }

  describe('opting in', () => {
    it('does nothing at all when the site did not opt in', () => {
      let requested = false
      interceptor.withMockXhr(() => {
        requested = true
      })

      start(mockRumConfiguration({ remoteConfig: undefined }))

      expect(requested).toBeFalse()
      expect(buildRemoteConfigSetup({ ...INIT_CONFIGURATION, remoteConfigurationEnabled: false })).toBeUndefined()
      expect(readRemoteConfig(undefined)).toEqual({})
    })
  })

  describe('storing what the server sends', () => {
    it('keeps the rates the server reports', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 42, sessionReplaySampleRate: 7 } }))

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 42, sessionReplaySampleRate: 7, version: 3 })
        done()
      })
      start(configurationWith())
    })

    it('keeps a zero rate, which is a deliberate setting and not a missing one', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 0 } }))

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 0, version: 3 })
        done()
      })
      start(configurationWith())
    })

    it('leaves out a rate the server did not report, so it stays with the value passed to init', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 42 } }))

        expect(readRemoteConfig(setup).sessionReplaySampleRate).toBeUndefined()
        done()
      })
      start(configurationWith())
    })

    it('keeps the trace rate and the privacy level the server reports', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { traceSampleRate: 25, defaultPrivacyLevel: 'allow' } }))

        expect(readRemoteConfig(setup)).toEqual({ traceSampleRate: 25, defaultPrivacyLevel: 'allow', version: 3 })
        done()
      })
      start(configurationWith())
    })

    it('drops a privacy level it does not recognise rather than passing it on', (done) => {
      // A typo must not reach the recorders: an unknown value there falls through to recording
      // everything, which is the one outcome nobody asks for by accident.
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 50, defaultPrivacyLevel: 'masked' } }))

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 50, version: 3 })
        done()
      })
      start(configurationWith())
    })

    it('keeps the custom bag the server reports, verbatim', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: {}, custom: { viplist: ['u-1', 'u-2'], debug: true } }))

        expect(readRemoteConfig(setup).custom).toEqual({ viplist: ['u-1', 'u-2'], debug: true })
        done()
      })
      start(configurationWith())
    })

    it('forgets the custom bag when the kill switch is off', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ custom: { debug: true } }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ enabled: false, custom: { debug: true } }))

        expect(readRemoteConfig(setup).custom).toBeUndefined()
        done()
      })
      start(configurationWith())
    })

    it('forgets the rates once remote configuration is switched off', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ enabled: false }))

        // The rates are gone, but the version is kept: the console still needs to see that this
        // client is up to date with the change that turned them off.
        expect(readRemoteConfig(setup)).toEqual({ version: 3 })
        done()
      })
      start(configurationWith())
    })

    it('refuses settings published before the ones it already has', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42, version: 8 }))

      interceptor.withMockXhr((xhr) => {
        // Another tab's request crossed this one, or an intermediary kept a copy. Either way this
        // answer is about settings the console has already replaced.
        xhr.complete(200, body({ version: 7, rum: { sessionSampleRate: 1 } }))

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 42, version: 8 })
        done()
      })
      start(configurationWith())
    })

    it('applies a rollback, which arrives as a new version carrying the earlier settings', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42, version: 8 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ version: 9, rum: { sessionSampleRate: 1 } }))

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 1, version: 9 })
        done()
      })
      start(configurationWith())
    })
  })

  describe('announcing that new settings are in storage', () => {
    function watchStoredNotifications() {
      const notified = jasmine.createSpy('remoteConfigurationStored')
      lifeCycle.subscribe(LifeCycleEventType.REMOTE_CONFIGURATION_STORED, notified)
      return notified
    }

    it('announces settings that reached storage, so a subscriber can act on them', (done) => {
      const notified = watchStoredNotifications()

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 0 } }))

        expect(notified).toHaveBeenCalledTimes(1)
        done()
      })
      start(configurationWith())
    })

    it('stays silent about settings it refused as older than the ones it holds', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42, version: 8 }))
      const notified = watchStoredNotifications()

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ version: 7, rum: { sessionSampleRate: 0 } }))

        // Nothing changed in storage, so nothing downstream may behave as though it had.
        expect(notified).not.toHaveBeenCalled()
        done()
      })
      start(configurationWith())
    })

    it('stays silent when the answer never reached storage', (done) => {
      const notified = watchStoredNotifications()
      spyOn(Storage.prototype, 'setItem').and.throwError('storage is full')

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 0 } }))

        // The next draw will not find these settings, so ending a session for their sake would end
        // it for nothing.
        expect(notified).not.toHaveBeenCalled()
        done()
      })
      start(configurationWith())
    })

    it('stays silent about an answer that never made it', (done) => {
      const notified = watchStoredNotifications()

      interceptor.withMockXhr((xhr) => {
        xhr.complete(500)

        expect(notified).not.toHaveBeenCalled()
        done()
      })
      start(configurationWith())
    })
  })

  describe('refusing a payload it cannot read', () => {
    const STORED = { sessionSampleRate: 42, version: 2 }

    beforeEach(() => localStorage.setItem(setup!.storeKey, JSON.stringify(STORED)))

    it('keeps the settings in force when the schema version is one this build does not know', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ rum: { sessionSampleRate: 5 }, schemaVersion: 2 }))

        // Not applied and not stored: a shape this build may misread must not reach the recorders,
        // and must not evict what is already working.
        expect(readRemoteConfig(setup)).toEqual(STORED)
        done()
      })
      start(configurationWith())
    })

    it('keeps the settings in force when a response carries no schema version at all', (done) => {
      interceptor.withMockXhr((xhr) => {
        // Written out rather than built through `body`, because a destructuring default treats an
        // explicit `undefined` as "not passed" — the reason the test this replaces was stamping a
        // schema version while claiming to omit one, and so never exercised this branch.
        //
        // The stamp is what tells a configuration from any other JSON. Without it the envelope is
        // `version` and `enabled`, which an ordinary health or feature-flag payload also has.
        xhr.complete(200, '{"version":9,"enabled":true,"rum":{"sessionSampleRate":5}}')

        expect(readRemoteConfig(setup)).toEqual(STORED)
        done()
      })
      start(configurationWith())
    })

    it('reads a null rum as an empty one rather than refusing the response', (done) => {
      interceptor.withMockXhr((xhr) => {
        // Serializers write `null` for an empty optional struct. The field's contract says absent
        // means empty, so `null` has to mean it too — refusing the response over it would freeze a
        // whole fleet on the settings it already had.
        xhr.complete(200, '{"schema_version":1,"version":9,"enabled":true,"rum":null}')

        expect(readRemoteConfig(setup)).toEqual({ version: 9 })
        done()
      })
      start(configurationWith())
    })

    it('refuses a response whose rum is not an object at all', (done) => {
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, '{"schema_version":1,"version":9,"enabled":true,"rum":"none"}')

        expect(readRemoteConfig(setup)).toEqual(STORED)
        done()
      })
      start(configurationWith())
    })

    it('keeps the settings in force when a 200 carries something that is not a configuration', (done) => {
      interceptor.withMockXhr((xhr) => {
        // A captive portal or a gateway error page answering 200. Storing it would blank the cache
        // and drop the whole fleet back to its init settings.
        xhr.complete(200, '{}')

        expect(readRemoteConfig(setup)).toEqual(STORED)
        done()
      })
      start(configurationWith())
    })

    it('is not satisfied by a body that merely has a number called version', (done) => {
      interceptor.withMockXhr((xhr) => {
        // A misrouted proxy or an appliance's own status page. Carrying a numeric `version` is not
        // enough to be read as settings: storing it would blank the cache AND leave behind a number
        // that no genuine answer could ever climb over again.
        xhr.complete(200, '{"version":20260831,"status":"ok"}')

        expect(readRemoteConfig(setup)).toEqual(STORED)
        done()
      })
      start(configurationWith())
    })

    it('refuses a version that could not be a publish counter', (done) => {
      const bodies = [
        '{"schema_version":1,"version":1e999,"enabled":true,"rum":{"sessionSampleRate":5}}',
        '{"schema_version":1,"version":-1,"enabled":true,"rum":{"sessionSampleRate":5}}',
        '{"schema_version":1,"version":1.5,"enabled":true,"rum":{"sessionSampleRate":5}}',
      ]
      let refused = 0
      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, bodies[refused])
        expect(readRemoteConfig(setup)).toEqual(STORED)
        refused += 1
        if (refused === bodies.length) {
          done()
          return
        }
        lifeCycle.notify(LifeCycleEventType.SESSION_RENEWED)
      })
      start(configurationWith())
    })

    it('refuses a response that does not say whether the feature is on', (done) => {
      interceptor.withMockXhr((xhr) => {
        // The kill switch is read for truth, so a body without it — or with it stringified by a
        // careless serializer — would read as "on" and apply rates nobody published.
        xhr.complete(200, '{"schema_version":1,"version":9,"enabled":"false","rum":{"sessionSampleRate":5}}')

        expect(readRemoteConfig(setup)).toEqual(STORED)
        done()
      })
      start(configurationWith())
    })

    it('drops a custom bag that is not keyed, and keeps the rates beside it', (done) => {
      interceptor.withMockXhr((xhr) => {
        // `custom` belongs to the application, not to the envelope: a mistake in it must not switch
        // the platform's own knobs back off.
        xhr.complete(
          200,
          '{"schema_version":1,"version":9,"enabled":true,"rum":{"sessionSampleRate":5},"custom":[1,2]}'
        )

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 5, version: 9 })
        done()
      })
      start(configurationWith())
    })

    it('ignores a stored version that is not a whole number', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42, version: 7.5 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ version: 3, rum: { sessionSampleRate: 1 } }))

        // A publish counter is a whole number. Anything else was not written by this SDK, so it
        // does not get to hold the floor — otherwise 7.5 would refuse every publish up to 8.
        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 1, version: 3 })
        done()
      })
      start(configurationWith())
    })

    it('ignores a stored custom bag that is not keyed', () => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ version: 4, custom: [1, 2] }))

      expect(readRemoteConfig(setup)).toEqual({ version: 4 })
    })

    it('ignores a stored version that could not have been published, rather than letting it refuse everything', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42, version: 1e308 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, body({ version: 7, rum: { sessionSampleRate: 1 } }))

        // Storage can be written by anything on this origin and survives a downgrade. A number this
        // SDK could not have put there is read as no version at all — otherwise one bad write would
        // lock the application out of its own settings for the life of the entry.
        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 1, version: 7 })
        done()
      })
      start(configurationWith())
    })

    it('drops an answer that lands after it was stopped', () => {
      const requests: MockXhr[] = []
      interceptor.withMockXhr((xhr) => requests.push(xhr))

      const stop = start(configurationWith())
      stop()
      // A 200, not a failure: the other half of the guard. Storing this would write settings nobody
      // is reading any more, over the ones a restarted SDK would read next.
      requests[0].complete(200, body({ version: 9, rum: { sessionSampleRate: 1 } }))

      expect(readRemoteConfig(setup)).toEqual(STORED)
    })
  })

  describe('when building or sending the request throws', () => {
    it('survives a page that replaced XMLHttpRequest with something unusable', () => {
      // The same threat the proxy case has: whatever throws — the constructor, the listener
      // registration, or the url — reaches `startRum` ahead of everything that collects.
      const original = window.XMLHttpRequest
      window.XMLHttpRequest = function () {
        return {} as XMLHttpRequest
      } as unknown as typeof XMLHttpRequest
      registerCleanupTask(() => {
        window.XMLHttpRequest = original
      })
      const displaySpy = spyOn(display, 'error')

      expect(() => start(configurationWith())).not.toThrow()
      expect(displaySpy).toHaveBeenCalled()
      expect(readRemoteConfig(setup)).toEqual({})
    })

    it('does not let a proxy function take the page down with it', () => {
      // `proxy` as a function is the application's own code, run synchronously while the url is
      // built. This call sits inside `startRum` ahead of everything that collects, and inside a
      // lifecycle notification on every renewal — a throw escaping here would take the page's whole
      // collection with it, silently, over a settings request.
      const throwing = mockRumConfiguration({
        remoteConfig: buildRemoteConfigSetup({
          ...INIT_CONFIGURATION,
          proxy: () => {
            throw new Error('the application decided otherwise')
          },
        }),
      })

      expect(() => start(throwing)).not.toThrow()
      expect(readRemoteConfig(setup)).toEqual({})
    })
  })

  describe('the fetch timeout', () => {
    it('asks the request to give up after the value the site passed', () => {
      expect(
        buildRemoteConfigSetup({ ...INIT_CONFIGURATION, remoteConfigurationFetchTimeout: 500 })!.fetchTimeout
      ).toBe(500)
    })

    it('falls back to the default rather than refusing init, and says so', () => {
      const displaySpy = spyOn(display, 'error')

      // `xhr.timeout` takes an unsigned long, which truncates and then wraps modulo 2^32. So a
      // string lands as 0, `0.5` from someone thinking in seconds truncates to 0, a negative
      // number wraps to weeks, and 2^32 wraps back to 0 — and every one of those means the request
      // never gives up, which leaves the in-flight guard set and silently ends every later refresh
      // on the page.
      for (const bad of [-1, 0, 0.5, 'abc' as unknown as number, NaN, Infinity, 4294967296, 1e21]) {
        expect(
          buildRemoteConfigSetup({ ...INIT_CONFIGURATION, remoteConfigurationFetchTimeout: bad })!.fetchTimeout
        ).toBe(3 * ONE_SECOND)
      }
      expect(displaySpy).toHaveBeenCalledTimes(8)

      // The bounds are inclusive where they should be: one whole millisecond is usable, and so is
      // the largest value the unsigned long holds.
      for (const good of [1, 500, 4294967295]) {
        expect(
          buildRemoteConfigSetup({ ...INIT_CONFIGURATION, remoteConfigurationFetchTimeout: good })!.fetchTimeout
        ).toBe(good)
      }
    })
  })

  describe('fetching cadence', () => {
    // No polling: the rates only matter at the next draw, so the SDK asks once at start-up and
    // once per session renewal, and stays quiet in between.
    let clock: Clock

    beforeEach(() => {
      clock = mockClock()
      registerCleanupTask(() => clock.cleanup())
    })

    it('fetches once at start-up and stays quiet afterwards', () => {
      const requests: MockXhr[] = []
      interceptor.withMockXhr((xhr) => {
        requests.push(xhr)
        xhr.complete(200, body())
      })

      start(configurationWith())
      clock.tick(60 * 60 * ONE_SECOND)

      expect(requests.length).toBe(1)
    })

    it('fetches again when a session is renewed', () => {
      const requests: MockXhr[] = []
      interceptor.withMockXhr((xhr) => {
        requests.push(xhr)
        xhr.complete(200, body())
      })

      start(configurationWith())
      lifeCycle.notify(LifeCycleEventType.SESSION_RENEWED)

      expect(requests.length).toBe(2)
    })

    it('retries a failure quickly, then patiently, then gives up until the next trigger', () => {
      const requests: MockXhr[] = []
      interceptor.withMockXhr((xhr) => {
        requests.push(xhr)
        xhr.complete(500)
      })

      start(configurationWith())
      expect(requests.length).toBe(1)

      // First retry lands within 5s ± jitter.
      clock.tick(6 * ONE_SECOND + ONE_SECOND)
      expect(requests.length).toBe(2)

      // Second retry lands within 60s ± jitter.
      clock.tick(72 * ONE_SECOND + ONE_SECOND)
      expect(requests.length).toBe(3)

      // Budget exhausted: no matter how long the page sits there, nothing more is asked.
      clock.tick(60 * 60 * ONE_SECOND)
      expect(requests.length).toBe(3)

      // The next natural trigger starts a fresh attempt (with a fresh retry budget).
      lifeCycle.notify(LifeCycleEventType.SESSION_RENEWED)
      expect(requests.length).toBe(4)
    })

    it('treats a request that could not be built as a failed attempt, and retries it', () => {
      // `proxy` as a function is the application's own code. When it throws, nothing was sent — but
      // the in-flight guard must not stay set, or every later refresh on the page would be dropped.
      const requests: MockXhr[] = []
      let firstUrl = true
      const flaky = mockRumConfiguration({
        remoteConfig: buildRemoteConfigSetup({
          ...INIT_CONFIGURATION,
          proxy: ({ path, parameters }) => {
            if (firstUrl) {
              firstUrl = false
              throw new Error('not this time')
            }
            return `https://proxy.example.com${path}?${parameters}`
          },
        }),
      })
      interceptor.withMockXhr((xhr) => requests.push(xhr))

      start(flaky)
      expect(requests.length).toBe(0)

      clock.tick(6 * ONE_SECOND + ONE_SECOND)
      expect(requests.length).toBe(1)
    })

    it('is not wedged by a request aborted out from under it', () => {
      // `window.stop()`, a navigation, or a page restored from the back/forward cache with its
      // request already dead: neither load nor error nor timeout ever arrives, and the timeout does
      // not tick while a page is frozen. Without an answer the in-flight guard stays set and every
      // later refresh on the page is dropped.
      const requests: MockXhr[] = []
      interceptor.withMockXhr((xhr) => requests.push(xhr))

      start(configurationWith())
      expect(requests.length).toBe(1)

      requests[0].abort()
      lifeCycle.notify(LifeCycleEventType.SESSION_RENEWED)

      expect(requests.length).toBe(2)
    })

    it('asks for nothing more once it has been stopped', () => {
      const requests: MockXhr[] = []
      // Left in flight on purpose: the answer arrives after the SDK has been stopped, which is the
      // only moment at which a retry can be scheduled past the cleanup that was meant to prevent it.
      interceptor.withMockXhr((xhr) => requests.push(xhr))

      const stop = start(configurationWith())
      expect(requests.length).toBe(1)

      stop()
      requests[0].complete(500)
      clock.tick(6 * ONE_SECOND + ONE_SECOND)
      clock.tick(72 * ONE_SECOND + ONE_SECOND)

      expect(requests.length).toBe(1)
    })

    it('leaves the rates it already had alone rather than falling back to init', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(500)

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 42 })
        done()
      })
      start(configurationWith())
    })

    it('leaves the rates alone when the body makes no sense', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42 }))

      interceptor.withMockXhr((xhr) => {
        xhr.complete(200, 'not json')

        expect(readRemoteConfig(setup)).toEqual({ sessionSampleRate: 42 })
        done()
      })
      start(configurationWith())
    })
  })

  describe('telling the server what it is running', () => {
    it('identifies which SDK build is asking', (done) => {
      interceptor.withMockXhr((xhr) => {
        // Sent from the first release on: a rule targeting a particular build cannot be written
        // later, because the clients it would have to match are already deployed.
        expect(xhr.url).toContain('sdk=web')
        expect(xhr.url).toContain('sdk_version=')
        done()
      })
      start(configurationWith())
    })

    it('sends nothing the first time, when it is running nothing yet', (done) => {
      interceptor.withMockXhr((xhr) => {
        expect(xhr.url).not.toContain('applied_version')
        done()
      })
      start(configurationWith())
    })

    it('sends the stored version once it has one', (done) => {
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42, version: 17 }))

      interceptor.withMockXhr((xhr) => {
        // Sent on the request every client makes, kept or not, which is why it can answer "has my
        // change reached everyone" when the events cannot.
        expect(xhr.url).toContain('applied_version=17')
        done()
      })
      start(configurationWith())
    })

    it('sends a stored version of zero like any other', (done) => {
      // A console whose first published version is numbered 0. Reporting nothing for it would show
      // every client running it as one that never applied the change.
      localStorage.setItem(setup!.storeKey, JSON.stringify({ sessionSampleRate: 42, version: 0 }))

      interceptor.withMockXhr((xhr) => {
        expect(xhr.url).toContain('applied_version=0')
        done()
      })
      start(configurationWith())
    })

    it("is recognisable as the SDK's own traffic, so the page does not collect it", (done) => {
      interceptor.withMockXhr((xhr) => {
        // What keeps this request out of the data the SDK collects. Left unrecognised it is just
        // another XHR the page made: a resource event would be filed for it on every session
        // renewal, and the in-flight request would count towards the page activity that decides
        // when a view finished loading.
        expect(isIntakeUrl(xhr.url!)).toBeTrue()
        done()
      })
      start(configurationWith())
    })

    it('stays recognisable behind a proxy, where the whole query is encoded away', (done) => {
      const proxied = buildRemoteConfigSetup({ ...INIT_CONFIGURATION, proxy: 'https://proxy.example.com/rum' })

      interceptor.withMockXhr((xhr) => {
        expect(isIntakeUrl(xhr.url!)).toBeTrue()
        done()
      })
      start(configurationWith({ remoteConfig: proxied }))
    })

    it('sends it inside the forwarded request when the site uses a proxy', (done) => {
      const proxied = buildRemoteConfigSetup({ ...INIT_CONFIGURATION, proxy: 'https://proxy.example.com/rum' })
      localStorage.setItem(proxied!.storeKey, JSON.stringify({ version: 17 }))
      registerCleanupTask(() => localStorage.removeItem(proxied!.storeKey))

      interceptor.withMockXhr((xhr) => {
        // A proxy forwards what its `ddforward` parameter holds and nothing else, so a version
        // appended to the finished URL would be read by the proxy and stop there.
        const forwarded = new URL(xhr.url!).searchParams.get('ddforward')!
        expect(forwarded).toContain('applied_version=17')
        done()
      })
      start(configurationWith({ remoteConfig: proxied }))
    })
  })

  describe('the storage key', () => {
    it('separates applications, environments and versions', () => {
      const keyOf = (partial: Partial<RumInitConfiguration>) =>
        buildRemoteConfigSetup({ ...INIT_CONFIGURATION, ...partial })!.storeKey

      expect(keyOf({})).not.toEqual(keyOf({ applicationId: 'other' }))
      expect(keyOf({})).not.toEqual(keyOf({ env: 'production' }))
      expect(keyOf({})).not.toEqual(keyOf({ version: '1.2.4' }))
    })

    it('cannot be spelled the same way by two different identities', () => {
      // The separator has to be a character `encodeURIComponent` escapes. With `_`, which it leaves
      // alone, these two would share one cache entry and read each other's rates.
      const keyOf = (partial: Partial<RumInitConfiguration>) =>
        buildRemoteConfigSetup({ ...INIT_CONFIGURATION, ...partial })!.storeKey

      expect(keyOf({ env: 'prod', version: '1_0' })).not.toEqual(keyOf({ env: 'prod_1', version: '0' }))
    })

    it('separates whatever the server is able to tell apart', () => {
      // The guard on the coupling that is easy to miss. A targeting dimension is added in three
      // places — the SDK reports it, the server accepts it as a match key, and the key here
      // separates on it — and forgetting the third is silent: two clients entitled to different
      // answers would share one entry and overwrite each other's on every fetch.
      //
      // The check is derived: if changing a field changes the request, the server can vary its
      // answer on it, so the key must change too. The converse is not required — a key finer than
      // the server's targeting only costs an extra entry, never a wrong one.
      //
      // What it cannot do is notice a field nobody listed below, so the list is the maintained
      // part. `service` is on it while it is still inert: nothing reports it today, so the check
      // skips it, and the day it starts being reported this turns into a real assertion. Fields
      // that identify the application rather than target it are left off — `clientToken` travels
      // on the request but the key separates the same clients through `applicationId`.
      const urlOf = (partial: Partial<RumInitConfiguration>) =>
        buildRemoteConfigSetup({ ...INIT_CONFIGURATION, ...partial })!.buildUrl(undefined)
      const keyOf = (partial: Partial<RumInitConfiguration>) =>
        buildRemoteConfigSetup({ ...INIT_CONFIGURATION, ...partial })!.storeKey

      const candidates: Array<Partial<RumInitConfiguration>> = [
        { env: 'production' },
        { version: '9.9.9' },
        { service: 'checkout' },
        { applicationId: 'other-app' },
      ]

      for (const candidate of candidates) {
        if (urlOf(candidate) !== urlOf({})) {
          expect(keyOf(candidate))
            .withContext(`${JSON.stringify(candidate)} is reported to the server, so it must be keyed by`)
            .not.toEqual(keyOf({}))
        }
      }
    })

    it('carries the storage format version, so only a format change orphans the cache', () => {
      expect(buildRemoteConfigSetup(INIT_CONFIGURATION)!.storeKey.startsWith('_fc_rc_1_')).toBeTrue()
    })

    it('keys the draw record by application and environment, but not by application version', () => {
      // The record belongs to the session, and a session outlives a deploy: keying it by version
      // would lose the decision the moment a visitor with a live session lands on a new release.
      const keyOf = (partial: Partial<RumInitConfiguration>) => buildDrawStoreKey({ ...INIT_CONFIGURATION, ...partial })

      expect(keyOf({})).not.toEqual(keyOf({ applicationId: 'other' }))
      expect(keyOf({})).not.toEqual(keyOf({ env: 'production' }))
      expect(keyOf({})).toEqual(keyOf({ version: '1.2.4' }))
      expect(keyOf({})).not.toEqual(buildRemoteConfigSetup(INIT_CONFIGURATION)!.storeKey)
    })
  })
})
