import type {
  Configuration,
  InitConfiguration,
  MatchOption,
  RawTelemetryConfiguration,
} from '@flashcatcloud/browser-core'
import {
  getType,
  isMatchOption,
  serializeConfiguration,
  DefaultPrivacyLevel,
  TraceContextInjection,
  display,
  objectHasValue,
  validateAndBuildConfiguration,
  isSampleRate,
  isNumber,
  isExperimentalFeatureEnabled,
  ExperimentalFeature,
} from '@flashcatcloud/browser-core'
import type { RumEventDomainContext } from '../../domainContext.types'
import type { RumEvent } from '../../rumEvent.types'
import type { RumPlugin } from '../plugins'
import { isTracingOption } from '../tracing/tracer'
import type { PropagatorType, TracingOption } from '../tracing/tracer.types'

export const DEFAULT_PROPAGATOR_TYPES: PropagatorType[] = ['tracecontext']

export interface RumInitConfiguration extends InitConfiguration {
  // global options
  /**
   * The RUM application ID.
   */
  applicationId: string
  /**
   * Whether to propagate user and account IDs in the baggage header of trace requests.
   * @default false
   */
  propagateTraceBaggage?: boolean | undefined
  /**
   * Access to every event collected by the RUM SDK before they are sent to Datadog.
   * It allows:
   * - Enrich your RUM events with additional context attributes
   * - Modify your RUM events to modify their content, or redact sensitive sequences (see the list of editable properties)
   * - Discard selected RUM events
   *
   * See [Enrich And Control Browser RUM Data With beforeSend](https://docs.datadoghq.com/real_user_monitoring/guide/enrich-and-control-rum-data) for further information.
   */
  beforeSend?: ((event: RumEvent, context: RumEventDomainContext) => boolean) | undefined
  /**
   * A list of request origins ignored when computing the page activity.
   * See [How page activity is calculated](https://docs.datadoghq.com/real_user_monitoring/browser/monitoring_page_performance/#how-page-activity-is-calculated) for further information.
   */
  excludedActivityUrls?: MatchOption[] | undefined
  /**
   * URL pointing to the Datadog Browser SDK Worker JavaScript file. The URL can be relative or absolute, but is required to have the same origin as the web application.
   * See [Content Security Policy guidelines](https://docs.datadoghq.com/integrations/content_security_policy_logs/?tab=firefox#use-csp-with-real-user-monitoring-and-session-replay) for further information.
   */
  workerUrl?: string
  /**
   * Compress requests sent to the Datadog intake to reduce bandwidth usage when sending large amounts of data. The compression is done in a Worker thread.
   * See [Content Security Policy guidelines](https://docs.datadoghq.com/integrations/content_security_policy_logs/?tab=firefox#use-csp-with-real-user-monitoring-and-session-replay) for further information.
   */
  compressIntakeRequests?: boolean | undefined
  remoteConfigurationId?: string | undefined

  // tracing options
  /**
   * A list of request URLs used to inject tracing headers.
   * See [Connect RUM and Traces](https://docs.datadoghq.com/real_user_monitoring/platform/connect_rum_and_traces/?tab=browserrum) for further information.
   */
  allowedTracingUrls?: Array<MatchOption | TracingOption> | undefined

  /**
   * The percentage of requests to trace: 100 for all, 0 for none.
   * See [Connect RUM and Traces](https://docs.datadoghq.com/real_user_monitoring/platform/connect_rum_and_traces/?tab=browserrum) for further information.
   */
  traceSampleRate?: number | undefined
  /**
   * If you set a `traceSampleRate`, to ensure backend services' sampling decisions are still applied, configure the `traceContextInjection` initialization parameter to sampled.
   * @default sampled
   * See [Connect RUM and Traces](https://docs.datadoghq.com/real_user_monitoring/platform/connect_rum_and_traces/?tab=browserrum) for further information.
   */
  traceContextInjection?: TraceContextInjection | undefined

  // replay options
  /**
   * Allow to protect end user privacy and prevent sensitive organizational information from being collected.
   * @default mask
   * See [Replay Privacy Options](https://docs.datadoghq.com/real_user_monitoring/session_replay/browser/privacy_options) for further information.
   */
  defaultPrivacyLevel?: DefaultPrivacyLevel | undefined
  /**
   * If you are accessing Datadog through a custom subdomain, you can set `subdomain` to include your custom domain in the `getSessionReplayLink()` returned URL .
   * See [Connect Session Replay To Your Third-Party Tools](https://docs.datadoghq.com/real_user_monitoring/guide/connect-session-replay-to-your-third-party-tools) for further information.
   */
  subdomain?: string
  /**
   * The percentage of tracked sessions with [Browser RUM & Session Replay pricing](https://www.datadoghq.com/pricing/?product=real-user-monitoring--session-replay#real-user-monitoring--session-replay) features: 100 for all, 0 for none.
   * See [Configure Your Setup For Browser RUM and Browser RUM & Session Replay Sampling](https://docs.datadoghq.com/real_user_monitoring/guide/sampling-browser-plans) for further information.
   */
  sessionReplaySampleRate?: number | undefined
  /**
   * Whether the tracked sessions that `sessionReplaySampleRate` did not draw still record a replay,
   * uploaded only if the session reports an error. Default: false.
   *
   * Such a session records from the start and keeps at most the last minute of it in memory. If it
   * never reports an error, nothing is uploaded and the session is not billed. On the first error,
   * the withheld minute is uploaded and recording continues normally for the rest of the session.
   */
  sessionReplayOnError?: boolean | undefined
  /**
   * If the session is sampled for Session Replay, only start the recording when `startSessionReplayRecording()` is called, instead of at the beginning of the session. Default: if startSessionReplayRecording is 0, true; otherwise, false.
   * See [Session Replay Usage](https://docs.datadoghq.com/real_user_monitoring/session_replay/browser/#usage) for further information.
   */
  startSessionReplayRecordingManually?: boolean | undefined

  /**
   * Enables privacy control for action names.
   */
  enablePrivacyForActionName?: boolean | undefined // TODO next major: remove this option and make privacy for action name the default behavior
  /**
   * Enables automatic collection of users actions.
   * See [Tracking User Actions](https://docs.datadoghq.com/real_user_monitoring/browser/tracking_user_actions) for further information.
   * @default true
   */
  trackUserInteractions?: boolean | undefined
  /**
   * Specify your own attribute to use to name actions.
   * See [Declare a name for click actions](https://docs.datadoghq.com/real_user_monitoring/browser/tracking_user_actions/#declare-a-name-for-click-actions) for further information.
   */
  actionNameAttribute?: string | undefined

  // view options
  /**
   * Allows you to control RUM views creation. See [Override default RUM view names](https://docs.datadoghq.com/real_user_monitoring/browser/advanced_configuration/?tab=npm#override-default-rum-view-names) for further information.
   */
  trackViewsManually?: boolean | undefined
  /**
   * Enables collection of resource events.
   * @default true
   */
  trackResources?: boolean | undefined
  /**
   * Enables collection of long task events.
   * @default true
   */
  trackLongTasks?: boolean | undefined

  /**
   * List of plugins to enable. The plugins API is unstable and experimental, and may change without
   * notice. Please use only plugins provided by Datadog matching the version of the SDK you are
   * using.
   */
  plugins?: RumPlugin[] | undefined

  /**
   * Enables collection of features flags in chosen events.
   */
  trackFeatureFlagsForEvents?: FeatureFlagsForEvents[]

  /**
   * @experimental Not ready for production.
   * The percentage of users profiled. A value between 0 and 100.
   * @default 0
   */
  profilingSampleRate?: number | undefined
}

export type HybridInitConfiguration = Omit<RumInitConfiguration, 'applicationId' | 'clientToken'>

export type FeatureFlagsForEvents = 'vital' | 'action' | 'long_task' | 'resource'

export interface RumConfiguration extends Configuration {
  // Built from init configuration
  actionNameAttribute: string | undefined
  traceSampleRate: number
  rulePsr: number | undefined
  allowedTracingUrls: TracingOption[]
  excludedActivityUrls: MatchOption[]
  workerUrl: string | undefined
  compressIntakeRequests: boolean
  applicationId: string
  defaultPrivacyLevel: DefaultPrivacyLevel
  enablePrivacyForActionName: boolean
  sessionReplaySampleRate: number
  sessionReplayOnError: boolean
  startSessionReplayRecordingManually: boolean
  trackUserInteractions: boolean
  trackViewsManually: boolean
  trackResources: boolean
  trackLongTasks: boolean
  version?: string
  subdomain?: string
  customerDataTelemetrySampleRate: number
  traceContextInjection: TraceContextInjection
  plugins: RumPlugin[]
  trackFeatureFlagsForEvents: FeatureFlagsForEvents[]
  profilingSampleRate: number
  propagateTraceBaggage: boolean
}

export function validateAndBuildRumConfiguration(
  initConfiguration: RumInitConfiguration
): RumConfiguration | undefined {
  if (
    initConfiguration.trackFeatureFlagsForEvents !== undefined &&
    !Array.isArray(initConfiguration.trackFeatureFlagsForEvents)
  ) {
    display.warn('trackFeatureFlagsForEvents should be an array')
  }

  if (!initConfiguration.applicationId) {
    display.error('Application ID is not configured, no RUM data will be collected.')
    return
  }

  if (
    !isSampleRate(initConfiguration.sessionReplaySampleRate, 'Session Replay') ||
    !isSampleRate(initConfiguration.traceSampleRate, 'Trace')
  ) {
    return
  }

  if (initConfiguration.excludedActivityUrls !== undefined && !Array.isArray(initConfiguration.excludedActivityUrls)) {
    display.error('Excluded Activity Urls should be an array')
    return
  }

  const allowedTracingUrls = validateAndBuildTracingOptions(initConfiguration)
  if (!allowedTracingUrls) {
    return
  }

  const baseConfiguration = validateAndBuildConfiguration(initConfiguration)
  if (!baseConfiguration) {
    return
  }

  const profilingEnabled = isExperimentalFeatureEnabled(ExperimentalFeature.PROFILING)

  const sessionReplaySampleRate = initConfiguration.sessionReplaySampleRate ?? 0
  const sessionReplayOnError = !!initConfiguration.sessionReplayOnError

  // Each of these is a combination the customer can set that cannot apply to a single session. It
  // is valid, so validation lets it through - but silence would leave them waiting for data that is
  // never coming.
  if (sessionReplayOnError) {
    if (sessionReplaySampleRate === 100) {
      display.warn(
        'sessionReplayOnError only applies to sessions sessionReplaySampleRate did not draw, and that rate is 100: it will never apply.'
      )
    }
    if ((initConfiguration.sessionSampleRate ?? 100) === 0) {
      display.warn('sessionReplayOnError has no effect while sessionSampleRate is 0: no session is tracked.')
    }
    if (initConfiguration.startSessionReplayRecordingManually) {
      display.warn(
        'sessionReplayOnError needs the recording to already be running when the error happens, and startSessionReplayRecordingManually keeps it stopped until you start it: there would be nothing to release.'
      )
    }
  }

  return {
    applicationId: initConfiguration.applicationId,
    version: initConfiguration.version || undefined,
    actionNameAttribute: initConfiguration.actionNameAttribute,
    sessionReplaySampleRate,
    sessionReplayOnError,
    startSessionReplayRecordingManually:
      initConfiguration.startSessionReplayRecordingManually !== undefined
        ? !!initConfiguration.startSessionReplayRecordingManually
        : // An error-sampled session has to be recording before the error happens, otherwise there is
          // nothing to withhold and release. So it must auto-start just like a plain sampled one.
          sessionReplaySampleRate === 0 && !sessionReplayOnError,
    traceSampleRate: initConfiguration.traceSampleRate ?? 100,
    rulePsr: isNumber(initConfiguration.traceSampleRate) ? initConfiguration.traceSampleRate / 100 : undefined,
    allowedTracingUrls,
    excludedActivityUrls: initConfiguration.excludedActivityUrls ?? [],
    workerUrl: initConfiguration.workerUrl,
    compressIntakeRequests: !!initConfiguration.compressIntakeRequests,
    trackUserInteractions: !!(initConfiguration.trackUserInteractions ?? true),
    trackViewsManually: !!initConfiguration.trackViewsManually,
    trackResources: !!(initConfiguration.trackResources ?? true),
    trackLongTasks: !!(initConfiguration.trackLongTasks ?? true),
    subdomain: initConfiguration.subdomain,
    defaultPrivacyLevel: objectHasValue(DefaultPrivacyLevel, initConfiguration.defaultPrivacyLevel)
      ? initConfiguration.defaultPrivacyLevel
      : DefaultPrivacyLevel.MASK,
    enablePrivacyForActionName: !!initConfiguration.enablePrivacyForActionName,
    customerDataTelemetrySampleRate: 1,
    traceContextInjection: objectHasValue(TraceContextInjection, initConfiguration.traceContextInjection)
      ? initConfiguration.traceContextInjection
      : TraceContextInjection.SAMPLED,
    plugins: initConfiguration.plugins || [],
    trackFeatureFlagsForEvents: initConfiguration.trackFeatureFlagsForEvents || [],
    profilingSampleRate: profilingEnabled ? (initConfiguration.profilingSampleRate ?? 0) : 0, // Enforce 0 if profiling is not enabled, and set 0 as default when not set.
    propagateTraceBaggage: !!initConfiguration.propagateTraceBaggage,
    ...baseConfiguration,
  }
}

/**
 * Validates allowedTracingUrls and converts match options to tracing options
 */
function validateAndBuildTracingOptions(initConfiguration: RumInitConfiguration): TracingOption[] | undefined {
  if (initConfiguration.allowedTracingUrls === undefined) {
    return []
  }
  if (!Array.isArray(initConfiguration.allowedTracingUrls)) {
    display.error('Allowed Tracing URLs should be an array')
    return
  }
  if (initConfiguration.allowedTracingUrls.length !== 0 && initConfiguration.service === undefined) {
    display.error('Service needs to be configured when tracing is enabled')
    return
  }
  // Convert from (MatchOption | TracingOption) to TracingOption, remove unknown properties
  const tracingOptions: TracingOption[] = []
  initConfiguration.allowedTracingUrls.forEach((option) => {
    if (isMatchOption(option)) {
      tracingOptions.push({ match: option, propagatorTypes: DEFAULT_PROPAGATOR_TYPES })
    } else if (isTracingOption(option)) {
      tracingOptions.push(option)
    } else {
      display.warn(
        'Allowed Tracing Urls parameters should be a string, RegExp, function, or an object. Ignoring parameter',
        option
      )
    }
  })

  return tracingOptions
}

/**
 * Combines the selected tracing propagators from the different options in allowedTracingUrls
 */
function getSelectedTracingPropagators(configuration: RumInitConfiguration): PropagatorType[] {
  const usedTracingPropagators = new Set<PropagatorType>()

  if (Array.isArray(configuration.allowedTracingUrls) && configuration.allowedTracingUrls.length > 0) {
    configuration.allowedTracingUrls.forEach((option) => {
      if (isMatchOption(option)) {
        DEFAULT_PROPAGATOR_TYPES.forEach((propagatorType) => usedTracingPropagators.add(propagatorType))
      } else if (getType(option) === 'object' && Array.isArray(option.propagatorTypes)) {
        // Ensure we have an array, as we cannot rely on types yet (configuration is provided by users)
        option.propagatorTypes.forEach((propagatorType) => usedTracingPropagators.add(propagatorType))
      }
    })
  }

  return Array.from(usedTracingPropagators)
}

export function serializeRumConfiguration(configuration: RumInitConfiguration) {
  const baseSerializedConfiguration = serializeConfiguration(configuration)

  return {
    session_replay_sample_rate: configuration.sessionReplaySampleRate,
    // `session_replay_on_error` is deliberately not reported yet: the telemetry
    // configuration type is generated from the rum-events-format schema, so adding it needs a schema
    // change first, and that is a separate repository.
    start_session_replay_recording_manually: configuration.startSessionReplayRecordingManually,
    trace_sample_rate: configuration.traceSampleRate,
    trace_context_injection: configuration.traceContextInjection,
    action_name_attribute: configuration.actionNameAttribute,
    use_allowed_tracing_urls:
      Array.isArray(configuration.allowedTracingUrls) && configuration.allowedTracingUrls.length > 0,
    selected_tracing_propagators: getSelectedTracingPropagators(configuration),
    default_privacy_level: configuration.defaultPrivacyLevel,
    enable_privacy_for_action_name: configuration.enablePrivacyForActionName,
    use_excluded_activity_urls:
      Array.isArray(configuration.excludedActivityUrls) && configuration.excludedActivityUrls.length > 0,
    use_worker_url: !!configuration.workerUrl,
    compress_intake_requests: configuration.compressIntakeRequests,
    track_views_manually: configuration.trackViewsManually,
    track_user_interactions: configuration.trackUserInteractions,
    track_resources: configuration.trackResources,
    track_long_task: configuration.trackLongTasks,
    plugins: configuration.plugins?.map((plugin) => ({
      name: plugin.name,
      ...plugin.getConfigurationTelemetry?.(),
    })),
    track_feature_flags_for_events: configuration.trackFeatureFlagsForEvents,
    ...baseSerializedConfiguration,
  } satisfies RawTelemetryConfiguration
}
