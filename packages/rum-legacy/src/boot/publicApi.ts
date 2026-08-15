import { assembleEvent } from '../domain/eventAssembly'
import type { AssemblyConfiguration, ViewContext } from '../domain/eventAssembly'
import { startErrorCollection } from '../domain/errorCollection'
import { createSessionStore } from '../domain/sessionStore'
import { startViewManager } from '../domain/viewManager'
import { displayError, displayWarn } from '../tools/display'
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
  // Options that only apply to the modern bundle are accepted and ignored, so a page can share one
  // configuration object between both builds.
  [key: string]: unknown
}

type Context = { [key: string]: any }

/*
 * Every public method is wrapped: a failure inside the SDK must never surface as an exception in
 * the host page. This is the last line of the safety net, after the individual try/catch blocks in
 * the transport and collection layers.
 */
function monitor<Args extends any[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result | undefined {
  return function (...args: Args): Result | undefined {
    try {
      return fn(...args)
    } catch (error) {
      displayError('internal error', error)
      return undefined
    }
  }
}

export function makeRumLegacyPublicApi() {
  let running: ReturnType<typeof start> | undefined
  let initConfiguration: LegacyInitConfiguration | undefined

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

    const sessionStore = createSessionStore()
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
      const event = assembleEvent({
        type,
        configuration: assemblyConfiguration,
        sessionId: session.id,
        view,
        properties: withIdentityContexts(properties),
        context: mergeContext(globalContext, context),
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

    return {
      stop() {
        viewManager.stop()
        errorCollection.stop()
        batch.flush()
        batch.stop()
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
    const result: Context = {}
    for (const key in properties) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        result[key] = properties[key]
      }
    }
    if (!isEmpty(userContext)) {
      result.usr = userContext
    }
    // The schema requires an id on account, so an account without one is left out rather than
    // making every event invalid.
    if (!isEmpty(accountContext) && accountContext.id !== undefined) {
      result.account = accountContext
    }
    return result
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
      initConfiguration = configuration
      running = start(configuration)
    }),

    getInitConfiguration: monitor(() => initConfiguration),

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
      globalContext = context ?? {}
    }),
    getGlobalContext: monitor(() => globalContext),
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
      userContext = user ?? {}
    }),
    getUser: monitor(() => userContext),
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
      accountContext = account ?? {}
    }),
    getAccount: monitor(() => accountContext),
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
      running?.stop()
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
    setTrackingConsent: monitor(() => undefined),
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
      running?.stop()
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

function mergeContext(base: Context, extra?: Context): Context {
  if (!extra || isEmpty(extra)) {
    return base
  }
  const result: Context = {}
  for (const key in base) {
    if (Object.prototype.hasOwnProperty.call(base, key)) {
      result[key] = base[key]
    }
  }
  for (const key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      result[key] = extra[key]
    }
  }
  return result
}

function isEmpty(value: Context): boolean {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return false
    }
  }
  return true
}
