import { DISCARDED, HookNames } from '@flashcatcloud/browser-core'
import { SessionReplayState, SessionType } from '../rumSessionManager'
import type { RumSessionManager } from '../rumSessionManager'
import { RumEventType } from '../../rawRumEvent.types'
import type { RecorderApi } from '../../boot/rumPublicApi'
import type { DefaultRumEventAttributes, Hooks } from '../hooks'
import type { ViewHistory } from './viewHistory'

export function startSessionContext(
  hooks: Hooks,
  sessionManager: RumSessionManager,
  recorderApi: RecorderApi,
  viewHistory: ViewHistory
) {
  hooks.register(HookNames.Assemble, ({ eventType, startTime }): DefaultRumEventAttributes | DISCARDED => {
    const session = sessionManager.findTrackedSession(startTime)
    const view = viewHistory.findView(startTime)

    if (!session || !view) {
      return DISCARDED
    }

    // A session withholding its replay is recording, but nothing has been uploaded and nothing may
    // ever be. Reporting `has_replay` here would offer a replay that does not exist.
    const isReplayWithheld = session.sessionReplay === SessionReplayState.BUFFERED_ON_ERROR

    let hasReplay
    let sampledForReplay
    let sampledForErrorReplay
    let isActive
    if (eventType === RumEventType.VIEW) {
      // Records rather than merely a stats entry: a withheld buffer that was dropped rolls back what
      // it held, which leaves a view with an empty stats entry and no replay at all - and offering a
      // replay that was never uploaded is worse than not offering one. Records, not segments,
      // because a host bridge takes the records itself and no segment is ever built for them.
      const replayStats = recorderApi.getReplayStats(view.id)
      hasReplay = !isReplayWithheld && replayStats && replayStats.records_count > 0 ? true : undefined
      sampledForReplay = session.sessionReplay === SessionReplayState.SAMPLED
      // Tells a replay collected only because the session errored apart from one collected
      // unconditionally - the two cost differently and are answered by different questions.
      sampledForErrorReplay = session.sampledOnErrorReplay || undefined
      isActive = view.sessionIsActive ? undefined : false
    } else {
      hasReplay = !isReplayWithheld && recorderApi.isRecording() ? true : undefined
    }

    return {
      type: eventType,
      session: {
        id: session.id,
        type: SessionType.USER,
        has_replay: hasReplay,
        sampled_for_replay: sampledForReplay,
        sampled_for_error_replay: sampledForErrorReplay,
        is_active: isActive,
      },
    }
  })
}
