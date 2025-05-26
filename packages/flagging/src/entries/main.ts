import { defineGlobal, getGlobalObject } from '@flashcatcloud/browser-core'
import { flagging as importedFlagging } from '../hello'

export const datadogFlagging = importedFlagging

interface BrowserWindow extends Window {
  DD_FLAGGING?: typeof datadogFlagging
}
defineGlobal(getGlobalObject<BrowserWindow>(), 'DD_FLAGGING', datadogFlagging)
