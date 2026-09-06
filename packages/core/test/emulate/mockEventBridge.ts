import { DefaultPrivacyLevel } from '../../src/domain/configuration'
import { BridgeCapability } from '../../src/transport'
import type { BrowserWindowWithEventBridge, DatadogEventBridge } from '../../src/transport'
import { registerCleanupTask } from '../registerCleanupTask'

export function mockEventBridge({
  allowedWebViewHosts = [window.location.hostname],
  privacyLevel = DefaultPrivacyLevel.MASK,
  capabilities = [BridgeCapability.RECORDS],
  sessionId,
  anonymousId,
}: {
  allowedWebViewHosts?: string[]
  privacyLevel?: DefaultPrivacyLevel
  capabilities?: BridgeCapability[]
  // FLASHCAT FORK: host provided identifiers. When left out, the bridge does not implement the
  // corresponding method at all, which emulates a host built against an older SDK.
  sessionId?: string
  anonymousId?: string
} = {}) {
  const eventBridge: DatadogEventBridge = {
    send: (_msg: string) => undefined,
    getAllowedWebViewHosts: () => JSON.stringify(allowedWebViewHosts),
    getCapabilities: () => JSON.stringify(capabilities),
    getPrivacyLevel: () => privacyLevel,
    ...(sessionId !== undefined ? { getSessionId: () => sessionId } : {}),
    ...(anonymousId !== undefined ? { getAnonymousId: () => anonymousId } : {}),
  }

  ;(window as BrowserWindowWithEventBridge).DatadogEventBridge = eventBridge

  registerCleanupTask(() => {
    delete (window as BrowserWindowWithEventBridge).DatadogEventBridge
  })
  return eventBridge
}
