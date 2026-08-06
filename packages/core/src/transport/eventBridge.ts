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
   *
   * An empty string means the host has no such identifier right now — a session that expired and
   * has not been renewed, say. A host with nothing to report must answer `''`, never a made-up
   * value and never a stale one.
   *
   * "No identifier right now" is NOT the same thing as "this host does not implement the getter":
   * the first is a real state of a host that owns the identifier, the second is an older host that
   * leaves it to this SDK. Only the second may fall back to a placeholder — a host that answers
   * `''` has told us there is nothing to attribute data to, and this page must stop attributing
   * data until the host answers with an id again.
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
    // FLASHCAT FORK: see `DatadogEventBridge`. The two answers callers must tell apart:
    // `undefined` — the host does not implement the getter and does not own the session id;
    // `''`        — the host owns it and has no session right now.
    // Anything falsy a host may return instead of `''` (a `null`, say) is normalised to `''`: it
    // still comes from a host that implements the getter, so it still means "no session".
    getSessionId(): string | undefined {
      return eventBridgeGlobal.getSessionId ? eventBridgeGlobal.getSessionId() || '' : undefined
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
