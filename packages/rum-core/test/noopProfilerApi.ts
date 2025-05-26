import type { ProfilerApi } from '@flashcatcloud/browser-rum-core'
import { noop } from '@flashcatcloud/browser-core'

export const noopProfilerApi: ProfilerApi = {
  stop: noop,
  onRumStart: noop,
}
