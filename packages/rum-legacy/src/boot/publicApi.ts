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

    // The view is passed in rather than read back from the view manager: the first view update is
    // emitted while startViewManager is still running, before the binding below exists.
    function sendEvent(type: string, properties: Context, view: ViewContext, context?: Context): void {
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
        properties: withIdentityContexts(properties),
        context: context && !isEmptyObject(context) ? shallowMerge(globalContext, context) : globalContext,
      })
      batch.add(event)
    }

    const viewManager = startViewManager((properties, view) => {
      sendEvent('view', properties, view)
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
     * beforeunload and unload are the only signals available before IE10. The exit runs once: the
     * synchronous request it makes blocks the browser, and doing that twice while a page is closing
     * is worse than missing a second closing update on the rare cancelled navigation.
     */
    let exited = false
    function onPageExit(): void {
      if (exited) {
        return
      }
      exited = true
      // Closing the view inside the exit flush keeps the whole sequence on the synchronous
      // transport, including a buffer limit the closing update happens to cross.
      batch.flushOnExit(() => viewManager.endView())
    }

    // Wrapped: the browser calls this one, so an internal failure here would become an uncaught
    // error in the page rather than being contained.
    const guardedOnPageExit = monitor(onPageExit)
    const addEventListener = getZoneJsOriginalValue(window, 'addEventListener')
    addEventListener.call(window, 'beforeunload', guardedOnPageExit)
    addEventListener.call(window, 'unload', guardedOnPageExit)

    return {
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
      if (running) {
        displayWarn('SDK is already initialized, ignoring this call.')
        return
      }
      if (!validate(configuration)) {
        return
      }
      // Copied on the way in: pages commonly keep the object they passed, and this one is what a
      // later consent grant starts from.
      initConfiguration = shallowMerge(configuration, {}) as LegacyInitConfiguration
      trackingConsent = configuration.trackingConsent ?? TRACKING_CONSENT_GRANTED
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

    stopSession: monitor(() => {
      running?.stop(true)
      running = undefined
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
  Object.defineProperty(api, '_stop', {
    value: () => {
      running?.stop(true)
      running = undefined
    },
    enumerable: false,
  })

  return api
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
  if (
    configuration.sessionSampleRate !== undefined &&
    (typeof configuration.sessionSampleRate !== 'number' ||
      configuration.sessionSampleRate < 0 ||
      configuration.sessionSampleRate > 100)
  ) {
    displayError('Session Sample Rate should be a number between 0 and 100')
    return false
  }
  return true
}
