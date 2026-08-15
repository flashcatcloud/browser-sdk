import { defineGlobal } from '../boot/global'

// replaced at build time
declare const __BUILD_ENV__SDK_VERSION__: string

interface BrowserWindow extends Window {
  FC_RUM?: unknown
}

export const flashcatRumLegacy = {
  version: __BUILD_ENV__SDK_VERSION__,

  /**
   * Kept for parity with the modern bundle: once this script has run the SDK is loaded, so the
   * callback can be invoked straight away. The loader snippet's placeholder queues callbacks
   * registered before that point, and `defineGlobal` drains them below.
   */
  onReady(callback: () => void): void {
    callback()
  },
}

defineGlobal(window as BrowserWindow, 'FC_RUM', flashcatRumLegacy)
