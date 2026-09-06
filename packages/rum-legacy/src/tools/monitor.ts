import { displayError } from './display'

/**
 * Wraps a function so a failure inside the SDK can never surface in the host page.
 *
 * This covers two entry points. Public API methods are one, and anything the browser calls back
 * into is the other: a listener that throws turns an internal failure into an uncaught page error,
 * which is exactly what this build exists to avoid.
 */
export function monitor<Args extends any[], Result>(
  fn: (...args: Args) => Result
): (...args: Args) => Result | undefined {
  return function (...args: Args): Result | undefined {
    try {
      return fn(...args)
    } catch (error) {
      displayError('internal error', error)
      return undefined
    }
  }
}
