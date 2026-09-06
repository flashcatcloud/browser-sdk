import { displayError, displayWarn } from '../tools/display'

/*
 * Shape of the placeholder the loader snippet puts on `window` before either bundle has arrived:
 *
 * window.FC_RUM = window.FC_RUM || { q: [], onReady: function (c) { this.q.push(c) } }
 *
 * Note that `q` holds callbacks, matching what the modern bundle already drains. Queueing
 * `['init', options]` tuples instead would leave the modern bundle with a queue nobody consumes,
 * silently breaking initialisation on modern browsers.
 */
export interface QueuedGlobal {
  q?: Array<() => void>
  version?: string
}

export function defineGlobal<Host, Name extends keyof Host>(host: Host, name: Name, api: Host[Name]): void {
  const placeholder = host[name] as QueuedGlobal | undefined

  if (placeholder && !placeholder.q && placeholder.version) {
    displayWarn('SDK is loaded more than once. This is unsupported and might have unexpected behavior.')
  }

  host[name] = api

  if (placeholder && placeholder.q) {
    const queue = placeholder.q
    for (let i = 0; i < queue.length; i++) {
      // A throwing customer callback must not prevent the remaining ones from running, and must
      // never propagate out of the SDK into the host page.
      try {
        queue[i]()
      } catch (error) {
        displayError('onReady callback threw an error:', error)
      }
    }
  }
}
