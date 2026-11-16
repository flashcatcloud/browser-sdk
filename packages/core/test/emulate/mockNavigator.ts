import { registerCleanupTask } from '../registerCleanupTask'
import type { NetworkInformation } from '../../src'

export function setNavigatorOnLine(onLine: boolean) {
  Object.defineProperty(navigator, 'onLine', {
    get() {
      return onLine
    },
    configurable: true,
  })
  registerCleanupTask(() => {
    delete (navigator as any).onLine
  })
}

export function setNavigatorConnection(connection: Partial<NetworkInformation> | undefined) {
  Object.defineProperty(navigator, 'connection', {
    get() {
      return connection
    },
    configurable: true,
  })
  registerCleanupTask(() => {
    delete (navigator as any).connection
  })
}

// navigator.userAgentData exists in Chromium only, so it is defined rather than spied on: a spy needs
// the property to exist, and would throw in Firefox and Safari.
export function setNavigatorUserAgentData(
  userAgentData: { brands?: Array<{ brand: string; version: string }> } | undefined
) {
  Object.defineProperty(navigator, 'userAgentData', {
    get() {
      return userAgentData
    },
    configurable: true,
  })
  registerCleanupTask(() => {
    delete (navigator as any).userAgentData
  })
}
