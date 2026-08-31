import { DISCARDED, HookNames, round } from '@flashcatcloud/browser-core'
import { SessionReplayState, SessionType } from '../rumSessionManager'
import type { DrawnConfiguration, RumSessionManager } from '../rumSessionManager'
import { RumEventType } from '../../rawRumEvent.types'
import type { RecorderApi } from '../../boot/rumPublicApi'
import type { DefaultRumEventAttributes, Hooks } from '../hooks'
import type { ViewHistory } from './viewHistory'

/**
 * FLASHCAT FORK - what the shared schema says `_dd.configuration` holds, plus `rc_version`, which is
 * ours: our intake reads it and other consumers ignore it. Naming the addition here rather than
 * casting the whole `_dd` away keeps every field that DOES belong to the shared schema checked
 * against it, so a rename upstream still fails the build instead of silently emitting a dead field.
 */
type DrawnConfigurationAttributes = NonNullable<NonNullable<DefaultRumEventAttributes['_dd']>['configuration']> & {
  rc_version?: number
}

function drawnAttributes(drawn: DrawnConfiguration): DrawnConfigurationAttributes {
  return {
    session_sample_rate: round(drawn.sessionSampleRate, 3),
    session_replay_sample_rate: round(drawn.sessionReplaySampleRate, 3),
    rc_version: drawn.version,
  }
}

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

    let hasReplay
    let sampledForReplay
    let isActive
    if (eventType === RumEventType.VIEW) {
      hasReplay = recorderApi.getReplayStats(view.id) ? true : undefined
      sampledForReplay = session.sessionReplay === SessionReplayState.SAMPLED
      isActive = view.sessionIsActive ? undefined : false
    } else {
      hasReplay = recorderApi.isRecording() ? true : undefined
    }

    return {
      type: eventType,
      session: {
        id: session.id,
        type: SessionType.USER,
        has_replay: hasReplay,
        sampled_for_replay: sampledForReplay,
        is_active: isActive,
      },
      // FLASHCAT FORK - overrides the init values reported by the default context with the rates
      // this session was actually drawn under (remote settings and `beforeSampling` included), plus
      // the remote settings version they came from. Extrapolation and audits must line up with the
      // draw that kept the session, and the version lets an auditor recover the exact settings from
      // the console's version history. `rc_version` is a FlashCat addition on top of the shared
      // schema; our intake reads it, others ignore it.
      ...(session.drawnConfiguration
        ? { _dd: { configuration: drawnAttributes(session.drawnConfiguration) } }
        : undefined),
    }
  })
}
