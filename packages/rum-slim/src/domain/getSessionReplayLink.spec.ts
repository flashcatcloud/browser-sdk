import { INTAKE_SITE_US1 } from '@flashcatcloud/browser-core'
import type { RumConfiguration } from '@flashcatcloud/browser-rum-core'
import { getSessionReplayLink } from './getSessionReplayLink'

const DEFAULT_CONFIGURATION = {
  site: INTAKE_SITE_US1,
} as RumConfiguration

describe('getReplayLink (slim package)', () => {
  it('should return the replay link with a "slim-package" error type', () => {
    const link = getSessionReplayLink(DEFAULT_CONFIGURATION)

    expect(link).toBe('https://app.browser.flashcat.cloud/rum/replay/sessions/no-session-id?error-type=slim-package')
  })
})
