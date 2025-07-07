// eslint-disable-next-line
import { record as rrwebRecord } from '@rrweb/record'
import type { LifeCycle, RumConfiguration, ViewHistory } from '@flashcatcloud/browser-rum-core'
import { addTelemetryError, DefaultPrivacyLevel } from '@flashcatcloud/browser-core'
import type { BrowserRecord } from '../../types'

const SAMPLING_CONFIG = {
  SCROLL_THROTTLE_MS: 200,
  MEDIA_THROTTLE_MS: 800,
  INPUT_THROTTLE: 'last' as const,
} as const

const MOUSE_INTERACTION_CONFIG = {
  mouseUp: false,
  mouseDown: false,
  ContextMenu: false,
  Blur: false,
  Click: true,
} as const

const CHECKOUT_INTERVAL_MS = 3 * 60 * 1000 // 3 minutes

export interface RecordOptions {
  emit?: (record: BrowserRecord) => void
  configuration: RumConfiguration
  lifeCycle: LifeCycle
  viewHistory: ViewHistory
}

export interface RecordAPI {
  stop: () => void
  flushMutations: () => void
  shadowRootsController: {
    addShadowRoot: () => null
    removeShadowRoot: () => null
    flush: () => null
    stop: () => null
  }
}

function getMaskTextSelector(privacyLevel: DefaultPrivacyLevel): string | undefined {
  return privacyLevel === DefaultPrivacyLevel.MASK
    ? 'p, div, span, h1, h2, h3, h4, h5, h6, li, td, th, label, a'
    : undefined
}

const maskTextFunction = (text: string): string => Array(text.length).fill('*').join('')

export function record(options: RecordOptions): RecordAPI {
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
      scroll: SAMPLING_CONFIG.SCROLL_THROTTLE_MS,
      media: SAMPLING_CONFIG.MEDIA_THROTTLE_MS,
      mouseInteraction: MOUSE_INTERACTION_CONFIG,
      input: SAMPLING_CONFIG.INPUT_THROTTLE,
    },
    errorHandler: (error) => {
      addTelemetryError(error, { context: 'rrweb-record' })
    },
    recordCanvas: false,
    maskAllInputs: defaultPrivacyLevel !== DefaultPrivacyLevel.ALLOW,
    maskInputOptions: {
      tel: true,
      password: true,
    },
    maskTextSelector: getMaskTextSelector(defaultPrivacyLevel),
    maskTextFn: maskTextFunction,
    checkoutEveryNms: CHECKOUT_INTERVAL_MS,
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
