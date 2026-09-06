/*
 * Console access has to be defensive here, and it deliberately differs from the modern bundle's
 * display module, which captures `console` and binds its methods once at module evaluation.
 *
 * - In IE9, `window.console` does not exist at all until the developer tools are opened. Capturing
 *   it at load time would permanently capture `undefined`, and a bare `console.log` throws and
 *   takes the host page down with it. Hence the lazy lookup on every call.
 * - In IE9, the console methods are host objects rather than real functions: `typeof console.log`
 *   evaluates to 'object' and `console.log.bind` is undefined. Guarding with
 *   `typeof fn === 'function'` would silence logging on the exact browsers this build targets, and
 *   binding them throws. Hence the truthiness test and the direct call.
 */

const PREFIX = '[FC_RUM]'

function getConsole(): Console | undefined {
  return typeof console !== 'undefined' && console ? console : undefined
}

export function displayWarn(message: string): void {
  const consoleRef = getConsole()
  if (consoleRef && consoleRef.warn) {
    consoleRef.warn(`${PREFIX} ${message}`)
  }
}

export function displayError(message: string, error?: unknown): void {
  const consoleRef = getConsole()
  if (consoleRef && consoleRef.error) {
    consoleRef.error(`${PREFIX} ${message}`, error)
  }
}
