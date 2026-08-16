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
}

export interface AssembleOptions {
  type: string
  configuration: AssemblyConfiguration
  sessionId: string
  view: ViewContext
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
  const { type, configuration, sessionId, view, properties, context } = options

  const event: { [key: string]: any } = {
    type,
    date: dateNow(),
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
        session_sample_rate: configuration.sessionSampleRate,
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
