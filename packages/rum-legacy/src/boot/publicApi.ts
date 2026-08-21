import { assembleEvent } from '../domain/eventAssembly'
import type { AssemblyConfiguration, ViewContext } from '../domain/eventAssembly'
import { startErrorCollection } from '../domain/errorCollection'
import { createSessionStore, deleteSessionCookie } from '../domain/sessionStore'
import { startViewManager } from '../domain/viewManager'
import { displayError, displayWarn } from '../tools/display'
import { monitor } from '../tools/monitor'
import { isEmptyObject, shallowMerge } from '../tools/objectUtils'
import { getZoneJsOriginalValue } from '../tools/zoneJs'
import { startBatch } from '../transport/batch'
import { createHttpRequest } from '../transport/httpRequest'
import { createIntakeUrlBuilder, generateUUID } from '../transport/intakeUrl'

// replaced at build time
declare const __BUILD_ENV__SDK_VERSION__: string

export interface LegacyInitConfiguration {
  applicationId: string
  clientToken: string
  /**
   * Path or url the events are sent to, proxied to the intake by the customer's own server. Same
   * option name and same semantics as the modern bundle.
   */
  proxy: string
  service?: string
  version?: string
  env?: string
  sessionSampleRate?: number
  /** 'granted' or 'not-granted'. Anything else counts as not granted. Defaults to 'granted'. */
  trackingConsent?: string
  // Options that only apply to the modern bundle are accepted and ignored, so a page can share one
  // configuration object between both builds.
  [key: string]: unknown
}

type Context = { [key: string]: any }

const TRACKING_CONSENT_GRANTED = 'granted'
const TRACKING_CONSENT_NOT_GRANTED = 'not-granted'

export function makeRumLegacyPublicApi() {
  let running: ReturnType<typeof start> | undefined
  let initConfiguration: LegacyInitConfiguration | undefined

  // Collection only runs while this is exactly 'granted', matching the modern bundle. An
  // unrecognised value therefore withholds collection rather than silently enabling it.
  let trackingConsent: string = TRACKING_CONSENT_GRANTED
  // A consent management platform commonly calls setTrackingConsent before init, and the answer it
  // gives is the user's, not the page's. The configuration only supplies a default for a page that
  // has not answered yet.
  let trackingConsentSetExplicitly = false
  let initialized = false
  let globalContext: Context = {}
  let userContext: Context = {}
  let accountContext: Context = {}

  function start(configuration: LegacyInitConfiguration) {
    const assemblyConfiguration: AssemblyConfiguration = {
      applicationId: configuration.applicationId,
      sessionSampleRate: configuration.sessionSampleRate ?? 100,
      service: configuration.service,
      version: configuration.version,
    }

    const sessionStore = createSessionStore(assemblyConfiguration.sessionSampleRate)
    const buildUrl = createIntakeUrlBuilder({
      clientToken: configuration.clientToken,
      proxy: configuration.proxy,
      env: configuration.env,
      service: configuration.service,
      version: configuration.version,
    })
    const batch = startBatch(createHttpRequest(buildUrl))

    /*
     * Declared here rather than next to the page exit listeners below, which is where they are
     * used: the first view update is emitted while startViewManager is still running, so sendEvent
     * runs before anything declared after it has been initialised.
     */
    let exited = false
    let exiting = false
    function releaseExitGuard(): void {
      if (!exiting) {
        exited = false
      }
    }

    // The view is passed in rather than read back from the view manager: the first view update is
    // emitted while startViewManager is still running, before the binding below exists.
    function sendEvent(type: string, properties: Context, view: ViewContext, context?: Context, date?: number): void {
      const session = sessionStore.getOrCreateSession()
      if (!session.isTracked) {
        // Sampled out. The decision belongs to the session, so this holds for every event in it.
        return
      }
      const event = assembleEvent({
        type,
        configuration: assemblyConfiguration,
        sessionId: session.id,
        view,
        date,
        properties: withIdentityContexts(properties),
        context: context && !isEmptyObject(context) ? shallowMerge(globalContext, context) : globalContext,
      })
      batch.add(event)
      releaseExitGuard()
    }

    const viewManager = startViewManager((properties, view) => {
      // A view event is dated by when the view started, not by when this update was assembled. The
      // modern bundle does the same, so every update of one view shares a date and the closing
      // update does not appear to have happened at the moment the page was dismissed.
      sendEvent('view', properties, view, undefined, view.startTime)
    })

    // Both uncaught and manually added errors arrive here, so the count and the event stay in one
    // place and an error cannot be reported twice.
    const errorCollection = startErrorCollection((error, context) => {
      viewManager.addErrorCount()
      sendEvent('error', { error }, viewManager.getCurrentView(), context)
    })

    /*
     * Page exit is owned here rather than by the batch, because the order matters: the closing view
     * update carries the time spent and the error and action counts, and it has to be in the buffer
     * before the buffer is sent. A listener inside startBatch would always run first and flush an
     * empty buffer.
     *
     * beforeunload and unload are the only signals available before IE10, and both fire on the same
     * dismissal. The guard below keeps that from sending the synchronous request twice while the
     * page is closing, which would block the browser for a second time.
     *
     * It is released again by the next event that actually reaches the buffer, and only by that:
     * releaseExitGuard runs immediately after batch.add, so the guard falls exactly when there is
     * new data an exit would have to carry. Events produced by the exit flush itself do not
     * release it — they are part of the sequence being guarded.
     *
     * The rule is deliberately not "one exit per page". A cancelled navigation leaves the page
     * running, and a guard that stayed set would drop everything recorded from that point on,
     * because the real exit would find it already true. The cost is that an event arriving between
     * beforeunload and unload on a genuine dismissal buys a second synchronous request — which is
     * the right trade, since that request is what delivers the event instead of losing it. Do not
     * "tighten" this back into a one-shot guard without restoring the data loss with it.
     */
    function onPageExit(): void {
      if (exited) {
        return
      }
      exited = true
      exiting = true
      try {
        // Closing the view inside the exit flush keeps the whole sequence on the synchronous
        // transport, including a buffer limit the closing update happens to cross.
        batch.flushOnExit(() => viewManager.endView())
      } finally {
        exiting = false
      }
    }

    // Wrapped: the browser calls this one, so an internal failure here would become an uncaught
    // error in the page rather than being contained.
    const guardedOnPageExit = monitor(onPageExit)
    const addEventListener = getZoneJsOriginalValue(window, 'addEventListener')
    addEventListener.call(window, 'beforeunload', guardedOnPageExit)
    addEventListener.call(window, 'unload', guardedOnPageExit)

    return {
      expireSession() {
        sessionStore.expire()
      },
      stop(flushPending: boolean) {
        viewManager.stop()
        errorCollection.stop()
        if (flushPending) {
          batch.flush()
        }
        batch.stop()
        const removeEventListener = getZoneJsOriginalValue(window, 'removeEventListener')
        removeEventListener.call(window, 'beforeunload', guardedOnPageExit)
        removeEventListener.call(window, 'unload', guardedOnPageExit)
      },
      addError(value: unknown, context?: Context) {
        errorCollection.addError(value, context)
      },
      addAction(name: string, context?: Context) {
        viewManager.addActionCount()
        sendEvent(
          'action',
          {
            action: {
              id: generateUUID(),
              type: 'custom',
              target: { name },
            },
          },
          viewManager.getCurrentView(),
          context
        )
      },
      startView(name?: string) {
        viewManager.startView(name)
      },
    }
  }

  function withIdentityContexts(properties: Context): Context {
    const identity: Context = {}
    if (!isEmptyObject(userContext)) {
      identity.usr = userContext
    }
    // The schema requires an id on account, so an account without one is left out rather than
    // making every event invalid.
    if (!isEmptyObject(accountContext) && accountContext.id !== undefined) {
      identity.account = accountContext
    }
    return shallowMerge(properties, identity)
  }

  const api = {
    version: __BUILD_ENV__SDK_VERSION__,

    onReady(callback: () => void) {
      callback()
    },

    init: monitor((configuration: LegacyInitConfiguration) => {
      // Not `running`: between init and a consent grant nothing is running yet, and using it as the
      // initialised flag let a second init replace the configuration the first one was waiting on.
      if (initialized) {
        displayWarn('SDK is already initialized, ignoring this call.')
        return
      }
      if (!validate(configuration)) {
        // A rejected configuration leaves the SDK uninitialised, so a corrected call still works.
        return
      }
      initialized = true
      // Copied on the way in: pages commonly keep the object they passed, and this one is what a
      // later consent grant starts from.
      initConfiguration = shallowMerge(configuration, {}) as LegacyInitConfiguration
      if (!trackingConsentSetExplicitly) {
        trackingConsent = configuration.trackingConsent ?? TRACKING_CONSENT_GRANTED
      }
      if (trackingConsent === TRACKING_CONSENT_GRANTED) {
        running = start(configuration)
      }
    }),

    /*
     * Data is copied at both boundaries, in and out. Storing the caller's object would let an
     * unrelated later mutation change what every event carries, and returning it would let a caller
     * change SDK behaviour by mutating what it read. The standard bundles clone for the same
     * reason. Nested objects are still shared: the configuration holds only scalars, and cloning
     * arbitrarily deep customer data is not worth the code here.
     */
    getInitConfiguration: monitor(() => (initConfiguration ? shallowMerge(initConfiguration, {}) : undefined)),

    getInternalContext: monitor(() => undefined),

    addError: monitor((error: unknown, context?: Context) => {
      running?.addError(error, context)
    }),

    addAction: monitor((name: string, context?: Context) => {
      running?.addAction(name, context)
    }),

    startView: monitor((nameOrOptions?: string | { name?: string }) => {
      const name = typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions?.name
      running?.startView(name)
    }),

    // Renaming the current view is not possible here: a view event has already been sent under the
    // old name, so the rename is applied by starting a new view instead.
    setViewName: monitor((name: string) => {
      running?.startView(name)
    }),

    setGlobalContext: monitor((context: Context) => {
      globalContext = context ? shallowMerge(context, {}) : {}
    }),
    getGlobalContext: monitor(() => shallowMerge(globalContext, {})),
    setGlobalContextProperty: monitor((key: string, value: any) => {
      globalContext[key] = value
    }),
    removeGlobalContextProperty: monitor((key: string) => {
      delete globalContext[key]
    }),
    clearGlobalContext: monitor(() => {
      globalContext = {}
    }),

    setUser: monitor((user: Context) => {
      userContext = user ? shallowMerge(user, {}) : {}
    }),
    getUser: monitor(() => shallowMerge(userContext, {})),
    setUserProperty: monitor((key: string, value: any) => {
      userContext[key] = value
    }),
    removeUserProperty: monitor((key: string) => {
      delete userContext[key]
    }),
    clearUser: monitor(() => {
      userContext = {}
    }),

    setAccount: monitor((account: Context) => {
      accountContext = account ? shallowMerge(account, {}) : {}
    }),
    getAccount: monitor(() => shallowMerge(accountContext, {})),
    setAccountProperty: monitor((key: string, value: any) => {
      accountContext[key] = value
    }),
    removeAccountProperty: monitor((key: string) => {
      delete accountContext[key]
    }),
    clearAccount: monitor(() => {
      accountContext = {}
    }),

    // Ends the session, not the SDK. Collection carries on and the next event opens a new session,
    // which is the contract the standard bundles offer. The current view carries on too: there is
    // no session renewal signal here to hang a new one off, and the alternative — tearing the
    // pipeline down — leaves the page with an SDK that never records again.
    stopSession: monitor(() => {
      running?.expireSession()
    }),

    /*
     * Everything below exists so that a page written against the modern bundle keeps running here
     * unchanged. None of it can be supported on browsers without the underlying platform APIs:
     * there is no PerformanceObserver for vitals, no MutationObserver for session replay, and no
     * way to observe resource timings.
     *
     * They are no-ops rather than missing properties on purpose. A missing method throws
     * "undefined is not a function" and takes the host page down, which is the exact failure this
     * build exists to prevent.
     */
    setTrackingConsent: monitor((consent: string) => {
      if (consent !== TRACKING_CONSENT_GRANTED && consent !== TRACKING_CONSENT_NOT_GRANTED) {
        // Warned about rather than ignored: a typo would otherwise silently stop all collection.
        displayWarn(`Unknown tracking consent "${String(consent)}", treating it as not granted.`)
      }
      trackingConsentSetExplicitly = true
      if (consent === trackingConsent) {
        return
      }
      trackingConsent = consent

      if (consent === TRACKING_CONSENT_GRANTED) {
        if (initConfiguration && !running) {
          running = start(initConfiguration)
        }
        return
      }

      // Consent withdrawn: drop what is buffered rather than sending it, and forget the session so
      // a later consent starts a new one.
      running?.stop(false)
      running = undefined
      deleteSessionCookie()
    }),
    setViewContext: monitor(() => undefined),
    setViewContextProperty: monitor(() => undefined),
    getViewContext: monitor(() => ({})),
    addTiming: monitor(() => undefined),
    addFeatureFlagEvaluation: monitor(() => undefined),
    getSessionReplayLink: monitor(() => undefined),
    startSessionReplayRecording: monitor(() => undefined),
    stopSessionReplayRecording: monitor(() => undefined),
    addDurationVital: monitor(() => undefined),
    startDurationVital: monitor(() => undefined),
    stopDurationVital: monitor(() => undefined),
  }

  // Internal escape hatch used by the specs to tear down between runs, kept off the public surface
  // the same way the modern bundle hides its debug switch.
  const stop = () => {
    running?.stop(true)
    running = undefined
    initialized = false
  }
  try {
    // IE8 and the IE8 document mode only accept DOM objects here and throw for plain ones. Our own
    // loader snippet routes those browsers to this bundle, and a cosmetic hidden property is not
    // worth failing the whole evaluation for: falling back to a plain assignment keeps the page
    // free of the uncaught error the throw would otherwise become.
    Object.defineProperty(api, '_stop', { value: stop, enumerable: false })
  } catch {
    ;(api as unknown as { _stop: () => void })._stop = stop
  }

  return api
}

function isPercentage(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 100
}

function validate(configuration: LegacyInitConfiguration | undefined): boolean {
  if (!configuration) {
    displayError('Missing configuration')
    return false
  }
  if (!configuration.clientToken) {
    displayError('Client Token is not configured, we will not send any data.')
    return false
  }
  if (!configuration.applicationId) {
    displayError('Application ID is not configured, no RUM data will be collected.')
    return false
  }
  if (!configuration.proxy) {
    // Without a same-origin path there is nowhere to send to: these browsers cannot do a
    // cross-origin XMLHttpRequest with the headers the intake expects.
    displayError('proxy is not configured, we will not send any data.')
    return false
  }
  // Checked positively rather than by negating the range: NaN fails every comparison, so the
  // negated form would accept it, and NaN then fails the sampling comparison too. The SDK would
  // look configured and silently report nothing, which is the worst way for this to go wrong.
  if (configuration.sessionSampleRate !== undefined && !isPercentage(configuration.sessionSampleRate)) {
    displayError('Session Sample Rate should be a number between 0 and 100')
    return false
  }
  return true
}
