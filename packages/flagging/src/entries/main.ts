import { defineGlobal, getGlobalObject } from '@flashcatcloud/browser-core'
import { flagging as importedFlagging } from '../hello'

export const flashcatFlagging = importedFlagging

interface BrowserWindow extends Window {
  FC_FLAGGING?: typeof flashcatFlagging
}
defineGlobal(getGlobalObject<BrowserWindow>(), 'FC_FLAGGING', flashcatFlagging)
