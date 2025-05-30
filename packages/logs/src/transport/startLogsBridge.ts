import type { Context } from '@flashcatcloud/browser-core'
import { getEventBridge } from '@flashcatcloud/browser-core'
import type { LifeCycle } from '../domain/lifeCycle'
import { LifeCycleEventType } from '../domain/lifeCycle'
import type { LogsEvent } from '../logsEvent.types'

export function startLogsBridge(lifeCycle: LifeCycle) {
  const bridge = getEventBridge<'log', LogsEvent>()!

  lifeCycle.subscribe(LifeCycleEventType.LOG_COLLECTED, (serverLogsEvent: LogsEvent & Context) => {
    bridge.send('log', serverLogsEvent)
  })
}
