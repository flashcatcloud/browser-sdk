import type { BuildEnvWindow } from './buildEnv'
import { startLeakDetection } from './leakDetection'

beforeEach(() => {
  ;(window as unknown as BuildEnvWindow).__BUILD_ENV__SDK_VERSION__ = 'test'
  // reset globals
  ;(window as any).FC_LOGS = {}
  ;(window as any).FC_RUM = {}
  ;(window as any).IS_REACT_ACT_ENVIRONMENT = true
  // prevent 'Some of your tests did a full page reload!' issue
  window.onbeforeunload = () => 'stop'
  startLeakDetection()
  // Note: clearing cookies should be done in `beforeEach` rather than `afterEach`, because in some
  // cases the test patches the `document.cookie` getter (ex: `spyOnProperty(document, 'cookie',
  // 'get')`), which would prevent the `clearAllCookies` function from working properly.
  clearAllCookies()
})

function clearAllCookies() {
  document.cookie.split(';').forEach((c) => {
    document.cookie = c.replace(/=.*/, `=;expires=${new Date().toUTCString()};path=/;samesite=strict`)
  })
}
