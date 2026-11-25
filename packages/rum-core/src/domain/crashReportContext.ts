import { noop } from '@flashcatcloud/browser-core'
import { RumEventType } from '../rawRumEvent.types'
import type { RumViewEvent } from '../rumEvent.types'
import type { LifeCycle } from './lifeCycle'
import { LifeCycleEventType } from './lifeCycle'

/**
 * Room the browser keeps for our keys. The values are a few ids and names; a value that does not
 * fit is skipped on its own (`set` throws for it alone), the others are still written.
 */
export const CRASH_REPORT_BUFFER_BYTES = 2048

type CrashReportValues = { [key: string]: string | undefined }

interface CrashReportContext {
  initialize(length: number): Promise<void>
  set(key: string, value: string): void
  delete(key: string): void
}

/**
 * When the page's renderer crashes the SDK dies with it, and only the browser can report the
 * crash: it sends a `crash` report to the endpoint named by the page's `Reporting-Endpoints`
 * header. That report carries no session. Chromium 145+ attaches to it the keys a page stored in
 * `window.crashReport`, so here we keep the current session, view, release and user there, which
 * lets the crash be put on the session it happened in.
 *
 * The values are read off assembled view events, so they are exactly what was sent, after
 * `beforeSend`: a crash is attached to the session and view the intake already knows.
 */
export function startCrashReportContext(lifeCycle: LifeCycle) {
  const crashReport = (window as unknown as { crashReport?: CrashReportContext }).crashReport
  if (!crashReport || typeof crashReport.initialize !== 'function') {
    return { stop: noop }
  }

  const context: CrashReportContext = crashReport
  const written: CrashReportValues = {}
  let latest: CrashReportValues = {}
  let ready = false

  function write(values: CrashReportValues) {
    for (const key of Object.keys({ ...written, ...values })) {
      const value = values[key]
      if (value === written[key]) {
        continue
      }
      try {
        if (value === undefined) {
          context.delete(key)
          delete written[key]
        } else {
          context.set(key, value)
          written[key] = value
        }
      } catch {
        // too large for the buffer, or the context is unusable: that key goes unreported
      }
    }
  }

  function update(values: CrashReportValues) {
    latest = values
    if (ready) {
      write(latest)
    }
  }

  // `set` throws until `initialize` has resolved. A page that initialized it itself makes ours
  // reject, yet the context is initialized and accepts our keys, so both outcomes proceed.
  const onInitialized = () => {
    ready = true
    write(latest)
  }
  try {
    context.initialize(CRASH_REPORT_BUFFER_BYTES).then(onInitialized, onInitialized)
  } catch {
    return { stop: noop }
  }

  // Only the active view describes where a crash would happen. An ended view's last update comes
  // after its successor started, or after the session expired, and would bring back stale keys.
  const viewSubscription = lifeCycle.subscribe(LifeCycleEventType.RUM_EVENT_COLLECTED, (event) => {
    if (event.type === RumEventType.VIEW && (event as RumViewEvent).view.is_active !== false) {
      update(crashReportValues(event as RumViewEvent))
    }
  })
  // Without a session there is nothing a crash could be attached to; keys left from the ended
  // session would put a later crash on it.
  const expiredSubscription = lifeCycle.subscribe(LifeCycleEventType.SESSION_EXPIRED, () => update({}))

  return {
    stop: () => {
      viewSubscription.unsubscribe()
      expiredSubscription.unsubscribe()
      update({})
    },
  }
}

function crashReportValues(event: RumViewEvent): CrashReportValues {
  return {
    session_id: event.session.id,
    view_id: event.view.id,
    view_name: event.view.name,
    version: event.version,
    service: event.service,
    usr_id: event.usr?.id,
    usr_anonymous_id: event.usr?.anonymous_id,
  }
}
