import type { RawError, HttpRequest, DeflateEncoder } from '@flashcatcloud/browser-core'
import { createHttpRequest, addTelemetryDebug, canUseEventBridge, noop } from '@flashcatcloud/browser-core'
import type { LifeCycle, ViewHistory, RumConfiguration, RumSessionManager } from '@flashcatcloud/browser-rum-core'
import { LifeCycleEventType, SessionReplayState } from '@flashcatcloud/browser-rum-core'

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

  // Assigned once recording has started. Segment collection is created first because `record()`
  // emits into it, so the buffer reaches for the snapshot through this holder rather than directly.
  let takeSubsequentFullSnapshot: () => void = noop

  if (!canUseEventBridge()) {
    const segmentCollection = startSegmentCollection(
      lifeCycle,
      configuration,
      sessionManager,
      viewHistory,
      replayRequest,
      encoder,
      {
        getWithholdingSessionId: () => {
          const session = sessionManager.findTrackedSession()
          return session?.sessionReplay === SessionReplayState.BUFFERED_ON_ERROR ? session.id : undefined
        },
        isReleased: (sessionId) => {
          const session = sessionManager.findTrackedSession()
          // Still the same session, still one whose replay is kept only on an error, and no longer
          // withholding. The middle condition matters: a session can stop withholding without ever
          // erroring - an older SDK sharing the same store does not know these tracking types and
          // redraws them - and that is a session ending, not a replay earning its way out.
          return (
            !!session &&
            session.id === sessionId &&
            session.sampledOnErrorReplay &&
            session.sessionReplay !== SessionReplayState.BUFFERED_ON_ERROR
          )
        },
        restartFromFullSnapshot: () => takeSubsequentFullSnapshot(),
      }
    )
    addRecord = segmentCollection.addRecord
    cleanupTasks.push(segmentCollection.stop)
  } else {
    ;({ addRecord } = startRecordBridge(viewHistory))
  }

  const recording = record({
    emit: addRecord,
    configuration,
    lifeCycle,
    viewHistory,
  })
  takeSubsequentFullSnapshot = recording.takeSubsequentFullSnapshot
  cleanupTasks.push(recording.stop)

  return {
    stop: () => {
      cleanupTasks.forEach((task) => task())
    },
  }
}
