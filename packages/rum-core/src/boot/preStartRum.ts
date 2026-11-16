import type {
  TrackingConsentState,
  DeflateWorker,
  Context,
  ContextManager,
  BoundedBuffer,
  Duration,
} from '@flashcatcloud/browser-core'
import {
  createBoundedBuffer,
  display,
  canUseEventBridge,
  displayAlreadyInitializedError,
  willSyntheticsInjectRum,
  noop,
  timeStampNow,
  clocksNow,
  getEventBridge,
  initFeatureFlags,
  addTelemetryConfiguration,
  initFetchObservable,
  CustomerContextKey,
  setTimeout,
  clearTimeout,
  elapsed,
  relativeNow,
} from '@flashcatcloud/browser-core'
import {
  validateAndBuildRumConfiguration,
  type RumConfiguration,
  type RumInitConfiguration,
  type RemoteConfiguration,
  readRemoteConfig,
  buildRemoteConfigSetup,
  createRemoteConfiguration,
  shouldWaitForRemoteConfiguration,
  REMOTE_CONFIGURATION_WAIT,
} from '../domain/configuration'
import type { ViewOptions } from '../domain/view/trackViews'
import type { DurationVital, CustomVitalsState } from '../domain/vital/vitalCollection'
import { startDurationVital, stopDurationVital } from '../domain/vital/vitalCollection'
import { serializeRumConfiguration } from '../domain/configuration'
import { callPluginsMethod } from '../domain/plugins'
import { buildGlobalContextManager } from '../domain/contexts/globalContext'
import { buildUserContextManager } from '../domain/contexts/userContext'
import { buildAccountContextManager } from '../domain/contexts/accountContext'
import type { StartRumResult } from './startRum'
import type { RumPublicApiOptions, Strategy } from './rumPublicApi'

export function createPreStartStrategy(
  { ignoreInitIfSyntheticsWillInjectRum, startDeflateWorker }: RumPublicApiOptions,
  trackingConsentState: TrackingConsentState,
  customVitalsState: CustomVitalsState,
  doStartRum: (
    configuration: RumConfiguration,
    deflateWorker: DeflateWorker | undefined,
    initialViewOptions?: ViewOptions,
    remoteConfiguration?: RemoteConfiguration,
    remoteConfigurationWait?: Duration
  ) => StartRumResult
): Strategy {
  const bufferApiCalls = createBoundedBuffer<StartRumResult>()

  // TODO next major: remove the globalContextManager, userContextManager and accountContextManager from preStartStrategy and use an empty context instead
  const globalContext = buildGlobalContextManager()
  bufferContextCalls(globalContext, CustomerContextKey.globalContext, bufferApiCalls)

  const userContext = buildUserContextManager()
  bufferContextCalls(userContext, CustomerContextKey.userContext, bufferApiCalls)

  const accountContext = buildAccountContextManager()
  bufferContextCalls(accountContext, CustomerContextKey.accountContext, bufferApiCalls)

  let firstStartViewCall:
    | { options: ViewOptions | undefined; callback: (startRumResult: StartRumResult) => void }
    | undefined
  let deflateWorker: DeflateWorker | undefined

  let cachedInitConfiguration: RumInitConfiguration | undefined
  let cachedConfiguration: RumConfiguration | undefined

  // FLASHCAT FORK - see `createRemoteConfiguration`. Started at the start rather than at init, so
  // that no request goes out before consent is granted, exactly as when it was started with RUM.
  let remoteConfiguration: RemoteConfiguration | undefined
  let remoteConfigurationStarted = false
  // Set while the start waits for the first answer.
  let cancelWait: (() => void) | undefined
  let remoteConfigurationWait: Duration | undefined

  const trackingConsentStateSubscription = trackingConsentState.observable.subscribe(tryStartRum)

  const emptyContext: Context = {}

  function tryStartRum() {
    if (!cachedInitConfiguration || !cachedConfiguration) {
      return
    }

    if (!trackingConsentState.isGranted()) {
      forgetRemoteConfiguration()
      return
    }

    if (cancelWait) {
      return
    }

    if (!remoteConfigurationStarted) {
      remoteConfigurationStarted = true
      // FLASHCAT FORK - a page with nothing stored would draw its first session on the init values,
      // and for a visitor whose storage does not last until the next session that is every session.
      // So that page waits for the first answer before it starts, for at most
      // `REMOTE_CONFIGURATION_WAIT`; a page with settings stored starts at once, as it always has.
      //
      // Storage alone decides, not whether a session is already running: telling would mean reading
      // the session store before it is started. The cost is one wait, usually one round trip, on the
      // first page a visitor with a running session opens on an origin with nothing stored — another
      // subdomain under `trackSessionAcrossSubdomains`, or a site that just turned this on. That
      // session reports no wait: it goes with the draw the start made, and there was none.
      //
      // Ahead of the consent unsubscription below, so that consent withdrawn while waiting stops it;
      // see `forgetRemoteConfiguration`. The request goes out here rather than at the start because the
      // start is what waits for it; with `trackViewsManually` it is therefore made before the first
      // `startView`, and keeps to its retry budget if that never comes.
      if (!canUseEventBridge()) {
        const shouldWait = shouldWaitForRemoteConfiguration(cachedConfiguration.remoteConfig)
        remoteConfiguration = createRemoteConfiguration(cachedConfiguration)
        if (remoteConfiguration && shouldWait) {
          // Subscribed before the request goes out: an attempt that fails before anything is sent
          // is answered on the spot, and then the wait ends — and RUM starts — inside `refresh()`.
          cancelWait = waitForFirstAnswer(remoteConfiguration)
          remoteConfiguration.refresh()
          return
        }
        remoteConfiguration?.refresh()
      }
    }

    let initialViewOptions: ViewOptions | undefined

    if (cachedConfiguration.trackViewsManually) {
      if (!firstStartViewCall) {
        return
      }
      // An initial view is always created when starting RUM.
      // When tracking views automatically, any startView call before RUM start creates an extra
      // view.
      // When tracking views manually, we use the ViewOptions from the first startView call as the
      // initial view options, and we remove the actual startView call so we don't create an extra
      // view.
      bufferApiCalls.remove(firstStartViewCall.callback)
      initialViewOptions = firstStartViewCall.options
    }

    // FLASHCAT FORK - only now, once nothing is left to wait for: until RUM starts, a withdrawal has
    // to reach `forgetRemoteConfiguration`, and with `trackViewsManually` the start can wait for the
    // first `startView` long after consent was granted.
    trackingConsentStateSubscription.unsubscribe()

    const startRumResult = doStartRum(
      cachedConfiguration,
      deflateWorker,
      initialViewOptions,
      remoteConfiguration,
      remoteConfigurationWait
    )

    bufferApiCalls.drain(startRumResult)
  }

  /**
   * Waits for the first answer or `REMOTE_CONFIGURATION_WAIT`, whichever comes first, then tries to
   * start again. An answer that stored nothing — a failed request, a refused response — ends the
   * wait too: the retry it schedules is seconds away, and the start has already waited for one.
   * Answers how to give up on the wait without starting.
   */
  function waitForFirstAnswer({ answerObservable }: RemoteConfiguration) {
    const waitStart = relativeNow()
    const answerSubscription = answerObservable.subscribe(endWait)
    const timeoutId = setTimeout(endWait, REMOTE_CONFIGURATION_WAIT)

    function cancel() {
      answerSubscription.unsubscribe()
      clearTimeout(timeoutId)
      cancelWait = undefined
    }

    function endWait() {
      cancel()
      remoteConfigurationWait = elapsed(waitStart, relativeNow())
      tryStartRum()
    }

    return cancel
  }

  /**
   * Consent withdrawn before RUM started: nothing may be asked for until it is granted again — a
   * retry left scheduled would go out regardless — and the start begins afresh then, from whatever
   * is stored by that time.
   *
   * The session store is left as it is, as it is when consent is withdrawn and granted again while
   * the start waits for the first `startView`: a session in it is continued once RUM starts. Ending
   * it belongs to the session manager, which is not running yet.
   */
  function forgetRemoteConfiguration() {
    cancelWait?.()
    remoteConfiguration?.stop()
    remoteConfiguration = undefined
    remoteConfigurationStarted = false
    remoteConfigurationWait = undefined
  }

  function doInit(initConfiguration: RumInitConfiguration) {
    const eventBridgeAvailable = canUseEventBridge()
    if (eventBridgeAvailable) {
      initConfiguration = overrideInitConfigurationForBridge(initConfiguration)
    }

    // Update the exposed initConfiguration to reflect the bridge and remote configuration overrides
    cachedInitConfiguration = initConfiguration
    addTelemetryConfiguration(serializeRumConfiguration(initConfiguration))

    if (cachedConfiguration) {
      displayAlreadyInitializedError('FC_RUM', initConfiguration)
      return
    }

    const configuration = validateAndBuildRumConfiguration(initConfiguration)
    if (!configuration) {
      return
    }

    if (!eventBridgeAvailable && !configuration.sessionStoreStrategyType) {
      display.warn('No storage available for session. We will not send any data.')
      return
    }

    if (configuration.compressIntakeRequests && !eventBridgeAvailable && startDeflateWorker) {
      deflateWorker = startDeflateWorker(
        configuration,
        'Datadog RUM',
        // Worker initialization can fail asynchronously, especially in Firefox where even CSP
        // issues are reported asynchronously. For now, the SDK will continue its execution even if
        // data won't be sent to Datadog. We could improve this behavior in the future.
        noop
      )
      if (!deflateWorker) {
        // `startDeflateWorker` should have logged an error message explaining the issue
        return
      }
    }

    cachedConfiguration = configuration
    // Instrument fetch to track network requests
    // This is needed in case the consent is not granted and some customer
    // library (Apollo Client) is storing uninstrumented fetch to be used later
    // The subscription is needed so that the instrumentation process is completed
    initFetchObservable().subscribe(noop)

    trackingConsentState.tryToInit(configuration.trackingConsent)
    tryStartRum()
  }

  const addDurationVital = (vital: DurationVital) => {
    bufferApiCalls.add((startRumResult) => startRumResult.addDurationVital(vital))
  }

  const strategy: Strategy = {
    init(initConfiguration, publicApi) {
      if (!initConfiguration) {
        display.error('Missing configuration')
        return
      }
      // Set the experimental feature flags as early as possible, so we can use them in most places
      initFeatureFlags(initConfiguration.enableExperimentalFeatures)

      // Expose the initial configuration regardless of initialization success.
      cachedInitConfiguration = initConfiguration

      // If we are in a Synthetics test configured to automatically inject a RUM instance, we want
      // to completely discard the customer application RUM instance by ignoring their init() call.
      // But, we should not ignore the init() call from the Synthetics-injected RUM instance, so the
      // internal `ignoreInitIfSyntheticsWillInjectRum` option is here to bypass this condition.
      if (ignoreInitIfSyntheticsWillInjectRum && willSyntheticsInjectRum()) {
        return
      }

      callPluginsMethod(initConfiguration.plugins, 'onInit', { initConfiguration, publicApi })

      doInit(initConfiguration)
    },

    get initConfiguration() {
      return cachedInitConfiguration
    },

    getInternalContext: noop as () => undefined,

    stopSession: noop,

    setForcedSession() {
      bufferApiCalls.add((startRumResult) => startRumResult.setForcedSession())
    },

    getRemoteConfig() {
      // Before the SDK starts, the last stored bag still answers — that is what lets application
      // code read it right after init() without waiting for the first fetch.
      return cachedInitConfiguration
        ? readRemoteConfig(buildRemoteConfigSetup(cachedInitConfiguration)).custom
        : undefined
    },

    addTiming(name, time = timeStampNow()) {
      bufferApiCalls.add((startRumResult) => startRumResult.addTiming(name, time))
    },

    startView(options, startClocks = clocksNow()) {
      const callback = (startRumResult: StartRumResult) => {
        startRumResult.startView(options, startClocks)
      }
      bufferApiCalls.add(callback)

      if (!firstStartViewCall) {
        firstStartViewCall = { options, callback }
        tryStartRum()
      }
    },

    setViewName(name) {
      bufferApiCalls.add((startRumResult) => startRumResult.setViewName(name))
    },

    // View context APIs

    setViewContext(context) {
      bufferApiCalls.add((startRumResult) => startRumResult.setViewContext(context))
    },

    setViewContextProperty(key, value) {
      bufferApiCalls.add((startRumResult) => startRumResult.setViewContextProperty(key, value))
    },

    getViewContext: () => emptyContext,

    globalContext,
    userContext,
    accountContext,

    addAction(action) {
      bufferApiCalls.add((startRumResult) => startRumResult.addAction(action))
    },

    addError(providedError) {
      bufferApiCalls.add((startRumResult) => startRumResult.addError(providedError))
    },

    addFeatureFlagEvaluation(key, value) {
      bufferApiCalls.add((startRumResult) => startRumResult.addFeatureFlagEvaluation(key, value))
    },

    startDurationVital(name, options) {
      return startDurationVital(customVitalsState, name, options)
    },

    stopDurationVital(name, options) {
      stopDurationVital(addDurationVital, customVitalsState, name, options)
    },

    addDurationVital,
  }

  return strategy
}

function overrideInitConfigurationForBridge(initConfiguration: RumInitConfiguration): RumInitConfiguration {
  // FLASHCAT FORK (4/4) - see `sessionReplayDirectUpload` in RumInitConfiguration.
  // Upstream replaces the credentials with placeholders, because a page hosting a bridge is assumed
  // never to send a request of its own. `sessionReplayDirectUpload` breaks that assumption: the page
  // uploads Session Replay segments over HTTP, and the intake authenticates them with the client
  // token and stores them under the application id. Both have to survive for those uploads to be
  // accepted. RUM events are unaffected either way, as they go through `bridge.send()`, never HTTP.
  const keepIntakeCredentials = !!initConfiguration.sessionReplayDirectUpload
  return {
    ...initConfiguration,
    applicationId: keepIntakeCredentials ? initConfiguration.applicationId : '00000000-aaaa-0000-aaaa-000000000000',
    clientToken: keepIntakeCredentials ? initConfiguration.clientToken : 'empty',
    sessionSampleRate: 100,
    defaultPrivacyLevel: initConfiguration.defaultPrivacyLevel ?? getEventBridge()?.getPrivacyLevel(),
  }
}

function bufferContextCalls(
  preStartContextManager: ContextManager,
  name: CustomerContextKey,
  bufferApiCalls: BoundedBuffer<StartRumResult>
) {
  preStartContextManager.changeObservable.subscribe(() => {
    const context = preStartContextManager.getContext()
    bufferApiCalls.add((startRumResult) => startRumResult[name].setContext(context))
  })
}
