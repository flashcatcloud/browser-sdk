import { defineGlobal } from '../boot/global'
import { makeRumLegacyPublicApi } from '../boot/publicApi'

interface BrowserWindow extends Window {
  FC_RUM?: unknown
}

export const flashcatRumLegacy = makeRumLegacyPublicApi()

defineGlobal(window as BrowserWindow, 'FC_RUM', flashcatRumLegacy)
