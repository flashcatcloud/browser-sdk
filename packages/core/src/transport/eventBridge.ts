import { getGlobalObject } from '../tools/getGlobalObject'
import type { DefaultPrivacyLevel } from '../domain/configuration'

export interface BrowserWindowWithEventBridge extends Window {
  DatadogEventBridge?: DatadogEventBridge
}

export interface DatadogEventBridge {
  getCapabilities?(): string
  getPrivacyLevel?(): DefaultPrivacyLevel
  getAllowedWebViewHosts(): string
  send(msg: string): void
  /**
   * FLASHCAT FORK: identifiers owned by the host application.
   *
   * Both are optional: hosts built against an older SDK do not implement them, in which case the
   * web SDK falls back to its own placeholder values.
   *
   * They are expected to be synchronous: the host pushes updates to the bridge implementation
   * (e.g. an Electron preload script), which caches them and answers from that cache.
   */
  getSessionId?(): string
  getAnonymousId?(): string
}

export const enum BridgeCapability {
  RECORDS = 'records',
}

export function getEventBridge<T, E>() {
  const eventBridgeGlobal = getEventBridgeGlobal()

  if (!eventBridgeGlobal) {
    return
  }

  return {
    getCapabilities() {
      return JSON.parse(eventBridgeGlobal.getCapabilities?.() || '[]') as BridgeCapability[]
    },
    getPrivacyLevel() {
      return eventBridgeGlobal.getPrivacyLevel?.()
    },
    getAllowedWebViewHosts() {
      return JSON.parse(eventBridgeGlobal.getAllowedWebViewHosts()) as string[]
    },
    // FLASHCAT FORK: see `DatadogEventBridge`. Returns `undefined` when the host does not provide it.
    getSessionId() {
      return eventBridgeGlobal.getSessionId?.() || undefined
    },
    getAnonymousId() {
      return eventBridgeGlobal.getAnonymousId?.() || undefined
    },
    send(eventType: T, event: E, viewId?: string) {
      const view = viewId ? { id: viewId } : undefined
      eventBridgeGlobal.send(JSON.stringify({ eventType, event, view }))
    },
  }
}

export function bridgeSupports(capability: BridgeCapability): boolean {
  const bridge = getEventBridge()
  return !!bridge && bridge.getCapabilities().includes(capability)
}

export function canUseEventBridge(currentHost = getGlobalObject<Window>().location?.hostname): boolean {
  const bridge = getEventBridge()
  return (
    !!bridge &&
    bridge
      .getAllowedWebViewHosts()
      .some((allowedHost) => currentHost === allowedHost || currentHost.endsWith(`.${allowedHost}`))
  )
}

function getEventBridgeGlobal() {
  return getGlobalObject<BrowserWindowWithEventBridge>().DatadogEventBridge
}
