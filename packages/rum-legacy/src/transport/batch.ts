import { getZoneJsOriginalValue } from '../tools/zoneJs'
import type { HttpRequest } from './httpRequest'

const ONE_KIBI_BYTE = 1024

// Same limits as the modern bundle, so the intake sees batches of the shape it already handles.
export const BATCH_BYTES_LIMIT = 16 * ONE_KIBI_BYTE
export const BATCH_MESSAGES_LIMIT = 50
export const MESSAGE_BYTES_LIMIT = 256 * ONE_KIBI_BYTE
export const FLUSH_TIMEOUT = 30 * 1000

export interface Batch {
  add: (event: object) => void
  flush: () => void
  /**
   * Sends synchronously, for use while the page is unloading.
   *
   * `prepare` runs inside the exit: anything it adds is flushed by the same synchronous request,
   * and a buffer limit it happens to cross does not start an async one that the closing page would
   * never complete.
   */
  flushOnExit: (prepare?: () => void) => void
  stop: () => void
}

export function startBatch(request: HttpRequest): Batch {
  let messages: string[] = []
  let bytesCount = 0
  let stopped = false
  let exiting = false
  let flushTimeoutId: number | undefined

  function flush(useExitTransport?: boolean): void {
    cancelScheduledFlush()

    if (messages.length === 0) {
      return
    }

    const payload = messages.join('\n')
    messages = []
    bytesCount = 0

    if (useExitTransport || exiting) {
      request.sendOnExit(payload)
    } else {
      request.send(payload)
    }
  }

  function cancelScheduledFlush(): void {
    if (flushTimeoutId !== undefined) {
      getZoneJsOriginalValue(window, 'clearTimeout')(flushTimeoutId)
      flushTimeoutId = undefined
    }
  }

  function scheduleFlush(): void {
    if (flushTimeoutId === undefined) {
      flushTimeoutId = getZoneJsOriginalValue(window, 'setTimeout')(() => {
        flushTimeoutId = undefined
        flush()
      }, FLUSH_TIMEOUT) as unknown as number
    }
  }

  // Page exit is not handled here on purpose. The caller has to close the current view before the
  // buffer is sent, and a listener registered in this function would run before one registered by
  // the caller afterwards, flushing an empty buffer and losing the closing view event.
  return {
    add(event: object) {
      if (stopped) {
        return
      }

      const message = serialize(event)
      if (message === undefined) {
        return
      }

      const messageBytesCount = computeBytesCount(message)
      if (messageBytesCount > MESSAGE_BYTES_LIMIT) {
        // The intake would reject it anyway, and keeping it would block every following event.
        return
      }

      if (messages.length > 0 && bytesCount + messageBytesCount >= BATCH_BYTES_LIMIT) {
        flush()
      }

      messages.push(message)
      bytesCount += messageBytesCount

      if (messages.length >= BATCH_MESSAGES_LIMIT) {
        flush()
      } else {
        scheduleFlush()
      }
    },

    flush() {
      if (!stopped) {
        flush()
      }
    },

    flushOnExit(prepare?: () => void) {
      if (stopped) {
        return
      }
      exiting = true
      try {
        if (prepare) {
          prepare()
        }
        flush(true)
      } finally {
        // Reset, because beforeunload also fires for a navigation the user then cancels, and the
        // page would otherwise keep sending synchronously for the rest of its life.
        exiting = false
      }
    },

    stop() {
      stopped = true
      cancelScheduledFlush()
    },
  }
}

function serialize(event: object): string | undefined {
  // A circular or otherwise unserialisable event must cost only itself, not the whole batch.
  try {
    return JSON.stringify(event)
  } catch {
    return undefined
  }
}

/**
 * Counts the bytes the payload will actually occupy once encoded.
 *
 * TextEncoder does not exist in the browsers this build targets, and using `string.length` instead
 * would undercount any non-latin content by a factor of three, letting batches grow well past the
 * intake limit on pages that are not written in English.
 */
export function computeBytesCount(candidate: string): number {
  let count = 0

  for (let i = 0; i < candidate.length; i++) {
    const code = candidate.charCodeAt(i)

    if (code < 0x80) {
      count += 1
    } else if (code < 0x800) {
      count += 2
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < candidate.length) {
      const nextCode = candidate.charCodeAt(i + 1)
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        // A surrogate pair encodes a single 4 byte code point.
        count += 4
        i++
      } else {
        count += 3
      }
    } else {
      count += 3
    }
  }

  return count
}
