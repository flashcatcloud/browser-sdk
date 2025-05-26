import type { ProfilerApi } from '@datadog/browser-rum-core'
import { noop } from '@flashcatcloud/browser-rum'

export const noopProfilerApi: ProfilerApi = {
  stop: noop,
  onRumStart: noop,
}
