import {
  SKIPPED,
  canUseEventBridge,
  createContextManager,
  CustomerDataType,
  HookNames,
  isEmptyObject,
  storeContextManager,
} from '@flashcatcloud/browser-core'
import type { RumConfiguration } from '../configuration'
import type { RumSessionManager } from '../rumSessionManager'
import type { DefaultRumEventAttributes, Hooks } from '../hooks'

export function startUserContext(hooks: Hooks, configuration: RumConfiguration, sessionManager: RumSessionManager) {
  const userContextManager = buildUserContextManager()

  if (configuration.storeContextsAcrossPages) {
    storeContextManager(configuration, userContextManager, 'rum', CustomerDataType.User)
  }

  // FLASHCAT FORK (4/4) - see `sessionReplayDirectUpload` in RumInitConfiguration.
  // Whether the anonymous id belongs to us or to a host application. Evaluated once: a bridge is
  // injected before any page script runs, so its presence cannot change afterwards.
  const hasHostProvidedAnonymousId = canUseEventBridge()

  hooks.register(HookNames.Assemble, ({ eventType, startTime }): DefaultRumEventAttributes | SKIPPED => {
    const user = userContextManager.getContext()
    const session = sessionManager.findTrackedSession(startTime)

    if (session && session.anonymousId && !user.anonymous_id && !!configuration.trackAnonymousUser) {
      // FLASHCAT FORK (4/4) - the copy into `user.id` is a Flashcat addition, not upstream: on the
      // web it is what makes unique users countable, because that baseline only counts `usr.id` and
      // would otherwise miss every logged-out visitor.
      //
      // A host application does not need it and is harmed by it. Its baseline already prefers the
      // anonymous id (`COALESCE(usr_anonymous_id, usr_id)`), and that id is stable across logins,
      // so copying it into `usr.id` adds nothing while importing the web double-counting bug, where
      // one device is counted as two users before and after a login. `fc-sdk-electron` deliberately
      // does not backfill on the main process side; this keeps the renderer process consistent.
      //
      // Web behavior is untouched: without a bridge this is the original line.
      if (!hasHostProvidedAnonymousId) {
        user.id = isEmptyObject(user) ? session.anonymousId : user.id
      }
      user.anonymous_id = session.anonymousId
    }

    if (isEmptyObject(user)) {
      return SKIPPED
    }

    return {
      type: eventType,
      usr: user,
    }
  })

  return userContextManager
}

export function buildUserContextManager() {
  return createContextManager('user', {
    propertiesConfig: {
      id: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
    },
  })
}
