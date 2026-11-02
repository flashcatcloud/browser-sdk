import type { RumConfiguration } from '@flashcatcloud/browser-rum-core'
import { SPEC_ENDPOINTS } from '@flashcatcloud/browser-core/test'
import { validateAndBuildRumConfiguration } from '../src/domain/configuration'

export function mockRumConfiguration(partialConfig: Partial<RumConfiguration> = {}): RumConfiguration {
  const FAKE_APP_ID = 'appId'
  const baseConfig: RumConfiguration = {
    ...validateAndBuildRumConfiguration({
      clientToken: 'xxx',
      applicationId: FAKE_APP_ID,
      trackResources: true,
      trackLongTasks: true,
      trackAnonymousUser: true,
    })!,
    ...SPEC_ENDPOINTS,
    // Off by default in specs: the daily active report would otherwise fire a real request (and
    // arm its retry timers) in every spec that starts RUM. Specs for the report itself pass a
    // setup built by `buildActivePingSetup` through `partialConfig`.
    activePing: undefined,
  }
  return { ...baseConfig, ...partialConfig }
}
