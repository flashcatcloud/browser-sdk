import { getInitCookie, HookNames, SKIPPED } from '@flashcatcloud/browser-core'
import { createCookieObservable } from '../../browser/cookieObservable'
import { SessionType } from '../rumSessionManager'
import type { DefaultRumEventAttributes, Hooks } from '../hooks'

export const CI_VISIBILITY_TEST_ID_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'

export interface CiTestWindow extends Window {
  Cypress?: {
    env: (key: string) => string | undefined
  }
}

export type CiVisibilityContext = ReturnType<typeof startCiVisibilityContext>

export function startCiVisibilityContext(
  hooks: Hooks,
  cookieObservable = createCookieObservable(CI_VISIBILITY_TEST_ID_COOKIE_NAME)
) {
  let testExecutionId =
    getInitCookie(CI_VISIBILITY_TEST_ID_COOKIE_NAME) || (window as CiTestWindow).Cypress?.env('traceId')

  const cookieObservableSubscription = cookieObservable.subscribe((value) => {
    testExecutionId = value
  })

  hooks.register(HookNames.Assemble, ({ eventType }): DefaultRumEventAttributes | SKIPPED => {
    if (typeof testExecutionId !== 'string') {
      return SKIPPED
    }

    return {
      type: eventType,
      session: {
        type: SessionType.CI_TEST,
      },
      ci_test: {
        test_execution_id: testExecutionId,
      },
    }
  })

  return {
    stop: () => {
      cookieObservableSubscription.unsubscribe()
    },
  }
}
