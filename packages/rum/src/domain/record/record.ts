// eslint-disable-next-line
import { record as rrwebRecord } from '@rrweb/record'
import type { LifeCycle, RumConfiguration, ViewHistory } from '@flashcatcloud/browser-rum-core'
import type { BrowserRecord } from '../../types'

export interface RecordOptions {
  emit?: (record: BrowserRecord) => void
  configuration: RumConfiguration
  lifeCycle: LifeCycle
  viewHistory: ViewHistory
}
export interface RecordAPI {
  stop: () => void
  flushMutations: () => void
}

export function record(options: RecordOptions) {
  window.localStorage.setItem('is_test_sdk', 'true')
  const { emit } = options
  // runtime checks for user options
  if (!emit) {
    throw new Error('emit function is required')
  }
  // eslint-disable-next-line
  rrwebRecord({
    emit,
    checkoutEveryNms: 5 * 60 * 1000, // checkout every 5 minutes
  })
  const stop = () => null

  const flushMutations = () => null
  const shadowRootsController = {
    addShadowRoot() {
      return null
    },
    removeShadowRoot() {
      return null
    },
    flush() {
      return null
    },
    stop() {
      return null
    },
  }

  return {
    stop,
    flushMutations,
    shadowRootsController,
  }
}
