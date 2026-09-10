import type { RumConfiguration, RumSessionManager, ViewHistory, RumSession } from '@flashcatcloud/browser-rum-core'
import { getSessionReplayUrl, SessionReplayState } from '@flashcatcloud/browser-rum-core'
import { isBrowserSupported } from '../boot/isBrowserSupported'

export function getSessionReplayLink(
  configuration: RumConfiguration,
  sessionManager: RumSessionManager,
  viewHistory: ViewHistory,
  isRecordingStarted: boolean
): string | undefined {
  const session = sessionManager.findTrackedSession()
  const errorType = getErrorType(session, isRecordingStarted)
  const viewContext = viewHistory.findView()

  return getSessionReplayUrl(configuration, {
    viewContext,
    errorType,
    session,
  })
}

function getErrorType(session: RumSession | undefined, isRecordingStarted: boolean) {
  if (!isBrowserSupported()) {
    return 'browser-not-supported'
  }
  if (!session) {
    // possibilities:
    // - rum sampled out
    // - session expired (edge case)
    return 'rum-not-tracked'
  }
  if (session.sessionReplay === SessionReplayState.OFF) {
    // possibilities
    // - replay sampled out
    return 'incorrect-session-plan'
  }
  if (session.sessionReplay === SessionReplayState.BUFFERED_ON_ERROR) {
    // the session records, but nothing has been uploaded yet and nothing may ever be: there is no
    // replay to link to until the session reports an error
    return 'replay-not-started'
  }
  if (!isRecordingStarted) {
    return 'replay-not-started'
  }
}
