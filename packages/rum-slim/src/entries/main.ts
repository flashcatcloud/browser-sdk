// Keep the following in sync with packages/rum/src/entries/main.ts
import { defineGlobal, getGlobalObject } from '@flashcatcloud/browser-core'
import type { RumPublicApi } from '@flashcatcloud/browser-rum-core'
import { makeRumPublicApi, startRum } from '@flashcatcloud/browser-rum-core'
import { makeRecorderApiStub } from '../boot/stubRecorderApi'
import { makeProfilerApiStub } from '../boot/stubProfilerApi'

export type {
  CommonProperties,
  RumPublicApi as RumGlobal,
  RumInitConfiguration,
  // Events
  RumEvent,
  RumActionEvent,
  RumErrorEvent,
  RumLongTaskEvent,
  RumResourceEvent,
  RumViewEvent,
  // Events context
  RumEventDomainContext,
  RumViewEventDomainContext,
  RumErrorEventDomainContext,
  RumActionEventDomainContext,
  RumFetchResourceEventDomainContext,
  RumXhrResourceEventDomainContext,
  RumOtherResourceEventDomainContext,
  RumLongTaskEventDomainContext,
} from '@flashcatcloud/browser-rum-core'
export { DefaultPrivacyLevel } from '@flashcatcloud/browser-core'

export const flashcatRum = makeRumPublicApi(startRum, makeRecorderApiStub(), makeProfilerApiStub())

interface BrowserWindow extends Window {
  FC_RUM?: RumPublicApi
}
defineGlobal(getGlobalObject<BrowserWindow>(), 'FC_RUM', flashcatRum)
