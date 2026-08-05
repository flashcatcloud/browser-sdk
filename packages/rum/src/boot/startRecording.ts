import type { RawError, HttpRequest, DeflateEncoder } from '@flashcatcloud/browser-core'
import { createHttpRequest, addTelemetryDebug, canUseEventBridge } from '@flashcatcloud/browser-core'
import type { LifeCycle, ViewHistory, RumConfiguration, RumSessionManager } from '@flashcatcloud/browser-rum-core'
import { LifeCycleEventType } from '@flashcatcloud/browser-rum-core'

import { record } from '../domain/record'
import { startSegmentCollection, SEGMENT_BYTES_LIMIT } from '../domain/segmentCollection'
import type { BrowserRecord } from '../types'
import { startRecordBridge } from '../domain/startRecordBridge'

export function startRecording(
  lifeCycle: LifeCycle,
  configuration: RumConfiguration,
  sessionManager: RumSessionManager,
  viewHistory: ViewHistory,
  encoder: DeflateEncoder,
  httpRequest?: HttpRequest
) {
  const cleanupTasks: Array<() => void> = []

  const reportError = (error: RawError) => {
    lifeCycle.notify(LifeCycleEventType.RAW_ERROR_COLLECTED, { error })
    addTelemetryDebug('Error reported to customer', { 'error.message': error.message })
  }

  const replayRequest =
    httpRequest || createHttpRequest(configuration.sessionReplayEndpointBuilder, SEGMENT_BYTES_LIMIT, reportError)

  let addRecord: (record: BrowserRecord) => void

  // FLASHCAT FORK (2/3) - see `sessionReplayDirectUpload` in RumInitConfiguration.
  // Without the option, records are handed over to the host application through the bridge. With
  // it, they go through the regular segment collection and are uploaded from this page.
  if (!canUseEventBridge() || configuration.sessionReplayDirectUpload) {
    const segmentCollection = startSegmentCollection(
      lifeCycle,
      configuration,
      sessionManager,
      viewHistory,
      replayRequest,
      encoder
    )
    addRecord = segmentCollection.addRecord
    cleanupTasks.push(segmentCollection.stop)
  } else {
    ;({ addRecord } = startRecordBridge(viewHistory))
  }

  const { stop: stopRecording } = record({
    emit: addRecord,
    configuration,
    lifeCycle,
    viewHistory,
  })
  cleanupTasks.push(stopRecording)

  return {
    stop: () => {
      cleanupTasks.forEach((task) => task())
    },
  }
}
