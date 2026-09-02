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
    // ever be. An event assembled now cannot know which of the two it will turn out to be: the
    // segment covering it is dropped on the next view change and sent only if the error comes first,
    // and it is assembled before either happens - the final update of a view is emitted before the
    // view change that drops that view's segment. So it does not claim a replay. Whether the session
    // was *sampled* for one is a different question, answerable here, and answered below.
    const isReplayWithheld = session.sessionReplay === SessionReplayState.BUFFERED_ON_ERROR

    let hasReplay
    let sampledForReplay
    let sampledForError
    let sampledForErrorReplay
    let isActive
    if (eventType === RumEventType.VIEW) {
      // Records rather than merely a stats entry: a withheld buffer that was dropped rolls back what
      // it held, which leaves a view with an empty stats entry and no replay at all - and offering a
      // replay that was never uploaded is worse than not offering one. Records, not segments,
      // because a host bridge takes the records itself and no segment is ever built for them.
      const replayStats = recorderApi.getReplayStats(view.id)
      hasReplay = !isReplayWithheld && replayStats && replayStats.records_count > 0 ? true : undefined
      // A session that withholds its events withholds its replay alongside them, so if these events
      // are ever uploaded that replay is on its way with them. Reporting the state as it stands at
      // assembly time would mark the whole released burst as a session that has no replay.
      sampledForReplay =
        session.sessionReplay === SessionReplayState.SAMPLED || (isReplayWithheld && session.eventsWithheld)
      // Tells the backend that this session's detail only starts where the buffer reached, so the
      // gap before it reads as "not collected" rather than as missing data.
      sampledForError = session.sampledOnError || undefined
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
        sampled_for_error: sampledForError,
        sampled_for_error_replay: sampledForErrorReplay,
        is_active: isActive,
      },
    }
  })
}
