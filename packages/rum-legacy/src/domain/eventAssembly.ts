import { isEmptyObject, shallowMerge } from '../tools/objectUtils'
import { dateNow } from '../tools/timeUtils'

export interface AssemblyConfiguration {
  applicationId: string
  sessionSampleRate: number
  service?: string
  version?: string
}

export interface ViewContext {
  id: string
  url: string
  referrer: string
  /** When the view started. Every update of a view carries the same value. */
  startTime: number
}

export interface AssembleOptions {
  type: string
  configuration: AssemblyConfiguration
  sessionId: string
  /** Whether the session was kept only because it errored. It then stands for itself, see below. */
  sampledOnError: boolean
  view: ViewContext
  /** When the event happened. Defaults to now, which is wrong for a view: see below. */
  date?: number
  properties: { [key: string]: any }
  context?: { [key: string]: any }
}

/*
 * Builds the envelope every event shares. The shape is defined by the intake, not by this package,
 * so it mirrors what the modern bundle assembles: same field names, same nesting, same units.
 *
 * The event specific properties are merged last but cannot displace the identity fields, since the
 * `view` sub-object is merged rather than replaced.
 */
export function assembleEvent(options: AssembleOptions): object {
  const { type, configuration, sessionId, sampledOnError, view, date, properties, context } = options

  const event: { [key: string]: any } = {
    type,
    date: date ?? dateNow(),
    source: 'browser',
    application: {
      id: configuration.applicationId,
    },
    session: {
      id: sessionId,
      type: 'user',
    },
    view: {
      id: view.id,
      url: view.url,
      referrer: view.referrer,
    },
    _dd: {
      format_version: 2,
      drift: 0,
      configuration: {
        // A session the modern bundle kept only because it errored was not drawn by this rate, so it
        // stands for itself rather than for `100 / rate` sessions; 0 is read as "do not scale".
        session_sample_rate: sampledOnError ? 0 : configuration.sessionSampleRate,
        // Session replay cannot run here. Reporting 0 rather than omitting it keeps the field
        // meaningful downstream instead of reading as "unknown".
        session_replay_sample_rate: 0,
      },
    },
  }

  if (configuration.service) {
    event.service = configuration.service
  }
  if (configuration.version) {
    event.version = configuration.version
  }
  if (context && !isEmptyObject(context)) {
    event.context = context
  }

  for (const key in properties) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      const value = properties[key]
      event[key] = isPlainObject(event[key]) && isPlainObject(value) ? shallowMerge(event[key], value) : value
    }
  }

  return event
}

function isPlainObject(value: unknown): value is { [key: string]: any } {
  return typeof value === 'object' && value !== null && !(value instanceof Array)
}
