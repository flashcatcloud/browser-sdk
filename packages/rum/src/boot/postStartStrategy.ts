import type {
  LifeCycle,
  RumConfiguration,
  RumSessionManager,
  StartRecordingOptions,
  ViewHistory,
  RumSession,
} from '@flashcatcloud/browser-rum-core'
import { LifeCycleEventType, SessionReplayState } from '@flashcatcloud/browser-rum-core'
import { asyncRunOnReadyState, monitorError, type DeflateEncoder } from '@flashcatcloud/browser-core'
import { getSessionReplayLink } from '../domain/getSessionReplayLink'
import type { startRecording } from './startRecording'

export type StartRecording = typeof startRecording

export const enum RecorderStatus {
  // The recorder is stopped.
  Stopped,
  // The user started the recording while it wasn't possible yet. The recorder should start as soon
  // as possible.
  IntentToStart,
  // The recorder is starting. It does not record anything yet.
  Starting,
  // The recorder is started, it records the session.
  Started,
}

export interface Strategy {
  start: (options?: StartRecordingOptions) => void
  stop: () => void
  isRecording: () => boolean
  getSessionReplayLink: () => string | undefined
}

export function createPostStartStrategy(
  configuration: RumConfiguration,
  lifeCycle: LifeCycle,
  sessionManager: RumSessionManager,
  viewHistory: ViewHistory,
  loadRecorder: () => Promise<StartRecording | undefined>,
  getOrCreateDeflateEncoder: () => DeflateEncoder | undefined
): Strategy {
  let status = RecorderStatus.Stopped
  let stopRecording: () => void

  lifeCycle.subscribe(LifeCycleEventType.SESSION_EXPIRED, () => {
    if (status === RecorderStatus.Starting || status === RecorderStatus.Started) {
      stop()
      status = RecorderStatus.IntentToStart
    }
  })

  lifeCycle.subscribe(LifeCycleEventType.SESSION_RENEWED, () => {
    if (status === RecorderStatus.IntentToStart) {
      start()
    }
  })

  const doStart = async () => {
    const [startRecordingImpl] = await Promise.all([loadRecorder(), asyncRunOnReadyState(configuration, 'interactive')])

    if (status !== RecorderStatus.Starting) {
      return
    }

    const deflateEncoder = getOrCreateDeflateEncoder()
    if (!deflateEncoder || !startRecordingImpl) {
      status = RecorderStatus.Stopped
      return
    }

    ;({ stop: stopRecording } = startRecordingImpl(
      lifeCycle,
      configuration,
      sessionManager,
      viewHistory,
      deflateEncoder
    ))

    status = RecorderStatus.Started
  }

  function start(options?: StartRecordingOptions) {
    const session = sessionManager.findTrackedSession()
    if (canStartRecording(session, options)) {
      status = RecorderStatus.IntentToStart
      return
    }

    if (shouldForceReplay(session!, options)) {
      // Applied before the guard below, not after starting: a session that withholds its replay is
      // already recording, so the guard would return without ever releasing it - and releasing what
      // is held is the whole of what forcing means for such a session.
      sessionManager.setForcedReplay()
    }

    if (isRecordingInProgress(status)) {
      return
    }

    status = RecorderStatus.Starting

    // Intentionally not awaiting doStart() to keep it asynchronous
    doStart().catch(monitorError)
  }

  function stop() {
    if (status === RecorderStatus.Started) {
      stopRecording?.()
    }

    status = RecorderStatus.Stopped
  }

  return {
    start,
    stop,
    getSessionReplayLink() {
      return getSessionReplayLink(configuration, sessionManager, viewHistory, status !== RecorderStatus.Stopped)
    },
    isRecording: () => status === RecorderStatus.Started,
  }
}

function canStartRecording(session: RumSession | undefined, options?: StartRecordingOptions) {
  return !session || (session.sessionReplay === SessionReplayState.OFF && (!options || !options.force))
}

function isRecordingInProgress(status: RecorderStatus) {
  return status === RecorderStatus.Starting || status === RecorderStatus.Started
}

function shouldForceReplay(session: RumSession, options?: StartRecordingOptions) {
  return (
    options &&
    options.force &&
    // A withheld replay is as much in need of forcing as one that was never sampled: the host asked
    // for this user's replay, so it must not go on waiting for an error that may never come.
    (session.sessionReplay === SessionReplayState.OFF ||
      session.sessionReplay === SessionReplayState.BUFFERED_ON_ERROR)
  )
}
