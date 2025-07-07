// eslint-disable-next-line
import { record as rrwebRecord } from '@rrweb/record'
import type { LifeCycle, RumConfiguration, ViewHistory } from '@flashcatcloud/browser-rum-core'
import { addTelemetryError, DefaultPrivacyLevel } from '@flashcatcloud/browser-core'
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
  const { emit, configuration } = options
  const { defaultPrivacyLevel } = configuration

  if (!emit) {
    addTelemetryError(new Error('emit function is required'), { context: 'rrweb-record' })
  }
  const stop = rrwebRecord({
    emit: (record) => {
      emit?.(record as unknown as BrowserRecord)
    },
    sampling: {
      scroll: 200,
      media: 800,
      mouseInteraction: {
        mouseUp: false,
        mouseDown: false,
        ContextMenu: false,
        Blur: false,
        Click: true,
      },
      input: 'last',
    },
    errorHandler: (error) => {
      addTelemetryError(error, { context: 'rrweb-record' })
    },
    recordCanvas: false,
    maskAllInputs: defaultPrivacyLevel !== DefaultPrivacyLevel.ALLOW,
    maskInputOptions: {
      email: true,
      tel: true,
      password: true,
    },
    maskTextFn: (text) => (defaultPrivacyLevel === DefaultPrivacyLevel.MASK ? '********' : text),
    checkoutEveryNms: 3 * 60 * 1000,
  })

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
    stop: stop || (() => undefined),
    flushMutations,
    shadowRootsController,
  }
}
