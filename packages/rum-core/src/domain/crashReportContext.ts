import type { ContextManager } from '@flashcatcloud/browser-core'
import { noop } from '@flashcatcloud/browser-core'
import { RumEventType } from '../rawRumEvent.types'
import type { RumViewEvent } from '../rumEvent.types'
import type { LifeCycle } from './lifeCycle'
import { LifeCycleEventType } from './lifeCycle'
import { STUB_SESSION_ID } from './rumSessionManager'

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
 * The values are read off assembled view events, so they are what the SDK sends, after
 * `beforeSend`.
 */
export function startCrashReportContext(lifeCycle: LifeCycle, userContext: ContextManager) {
  const crashReport = (window as unknown as { crashReport?: CrashReportContext }).crashReport
  if (!crashReport || typeof crashReport.initialize !== 'function') {
    return { stop: noop }
  }

  const context: CrashReportContext = crashReport
  const written: CrashReportValues = {}
  let latest: CrashReportValues = {}
  let ready = false

  function forget(key: string) {
    try {
      context.delete(key)
      delete written[key]
    } catch {
      // the context is unusable: nothing more to keep in sync
    }
  }

  function write(values: CrashReportValues) {
    // Removals first, so the room they free is there for the values set after them.
    for (const key of Object.keys(written)) {
      if (values[key] === undefined) {
        forget(key)
      }
    }
    for (const key of Object.keys(values)) {
      const value = values[key]
      if (value === undefined || value === written[key]) {
        continue
      }
      try {
        context.set(key, value)
        written[key] = value
      } catch {
        // Too large for the buffer. The previous value (another view's, another user's) must not
        // stay behind to be reported as this one; the key goes unreported.
        forget(key)
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
  // reject with InvalidStateError, yet the context is initialized and accepts our keys. Any other
  // rejection (an insecure context, a permissions policy) leaves it unusable.
  const onInitialized = () => {
    ready = true
    write(latest)
  }
  try {
    context.initialize(CRASH_REPORT_BUFFER_BYTES).then(onInitialized, (error: unknown) => {
      if ((error as { name?: string } | undefined)?.name === 'InvalidStateError') {
        onInitialized()
      }
    })
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
  // setUser / clearUser change no view, so the next view update may be minutes away. Until it brings
  // the new user (after beforeSend), report none rather than the one who just left.
  const userSubscription = userContext.changeObservable.subscribe(() => update({ ...latest, usr_id: undefined }))

  return {
    stop: () => {
      viewSubscription.unsubscribe()
      expiredSubscription.unsubscribe()
      userSubscription.unsubscribe()
      update({})
    },
  }
}

function crashReportValues(event: RumViewEvent): CrashReportValues {
  // In a WebView bridged to a native SDK that keeps the session, events carry a placeholder id the
  // host replaces when it forwards them. A crash report goes straight to the intake, unreplaced, so
  // the placeholder would put every such crash on one shared session.
  const hasSession = event.session.id !== STUB_SESSION_ID
  const session = event.session as { sampled_for_error?: boolean }
  return {
    session_id: hasSession ? nonEmpty(event.session.id) : undefined,
    view_id: hasSession ? nonEmpty(event.view.id) : undefined,
    // The session's events are withheld until an error, so the intake may hear of it only through
    // the crash; flagged, the crash is kept out of rates over sessions like those events would be.
    session_sampled_for_error: hasSession && session.sampled_for_error ? '1' : undefined,
    view_name: nonEmpty(event.view.name),
    version: nonEmpty(event.version),
    service: nonEmpty(event.service),
    usr_id: nonEmpty(event.usr?.id),
    usr_anonymous_id: nonEmpty(event.usr?.anonymous_id),
  }
}

function nonEmpty(value: unknown) {
  return typeof value === 'string' && value !== '' ? value : undefined
}
