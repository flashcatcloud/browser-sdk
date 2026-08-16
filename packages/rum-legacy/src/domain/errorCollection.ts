import { generateUUID } from '../transport/intakeUrl'

export interface CollectedError {
  id: string
  message: string
  source: string
  handling: string
  source_type: string
  type?: string
  stack?: string
}

/*
 * Error collection for browsers without a usable stack.
 *
 * window.onerror is the only source available: there is no unhandledrejection event, and IE9 passes
 * neither a column number nor an error object, so the message plus the script url and line is all
 * there is. That location is folded into a single synthetic stack frame, which is what makes the
 * error locatable in the UI at all.
 *
 * The handler the page had installed is preserved and still called. Replacing it outright would
 * silently disable the customer's own error reporting, which is exactly the kind of interference
 * this build must not cause.
 */
export function startErrorCollection(onError: (error: CollectedError, context?: { [key: string]: any }) => void) {
  const previousOnError = window.onerror

  function handleError(message: Event | string, url?: string, line?: number, column?: number, error?: Error): boolean {
    try {
      onError(computeError(message, url, line, error))
    } catch {
      // Never let a reporting failure become a page failure.
    }

    if (previousOnError) {
      try {
        // Returning the page handler's own result keeps its ability to suppress the browser's
        // default error logging.
        return previousOnError.call(window, message, url, line, column, error) as boolean
      } catch {
        // A broken page handler is not ours to propagate.
      }
    }

    return false
  }

  window.onerror = handleError

  return {
    addError(value: unknown, context?: { [key: string]: any }): void {
      onError(computeManualError(value), context)
    },

    stop(): void {
      if (window.onerror === handleError) {
        window.onerror = previousOnError
      }
    },
  }
}

function computeError(message: Event | string, url?: string, line?: number, error?: Error): CollectedError {
  const collected: CollectedError = {
    id: generateUUID(),
    message: typeof message === 'string' ? message : 'Unknown error',
    source: 'source',
    handling: 'unhandled',
    source_type: 'browser',
  }

  if (error) {
    fillFromError(collected, error)
    return collected
  }

  if (url) {
    // The single frame these browsers can offer. Without it the error has no location at all.
    collected.stack = `at <anonymous> @ ${url}:${line === undefined ? '?' : line}`
  }

  return collected
}

function computeManualError(value: unknown): CollectedError {
  const collected: CollectedError = {
    id: generateUUID(),
    message: '',
    source: 'custom',
    handling: 'handled',
    source_type: 'browser',
  }

  if (value instanceof Error) {
    fillFromError(collected, value)
  } else {
    collected.message = String(value)
  }

  return collected
}

/** Everything an Error instance can contribute. Anonymous errors keep the message already set. */
function fillFromError(collected: CollectedError, error: Error): void {
  collected.message = error.message || collected.message
  if (error.name) {
    collected.type = error.name
  }
  if (error.stack) {
    collected.stack = error.stack
  }
}
