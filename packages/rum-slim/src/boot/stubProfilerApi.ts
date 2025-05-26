import { noop } from '@flashcatcloud/browser-core'
import type { ProfilerApi } from '@flashcatcloud/browser-rum-core'

export function makeProfilerApiStub(): ProfilerApi {
  return {
    onRumStart: noop,
    stop: noop,
  }
}
