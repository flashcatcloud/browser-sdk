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
  stop: () => void
}

export function startBatch(request: HttpRequest): Batch {
  let messages: string[] = []
  let bytesCount = 0
  let stopped = false
  let flushTimeoutId: number | undefined

  function flush(useExitTransport?: boolean): void {
    cancelScheduledFlush()

    if (messages.length === 0) {
      return
    }

    const payload = messages.join('\n')
    messages = []
    bytesCount = 0

    if (useExitTransport) {
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

  function onPageExit(): void {
    if (!stopped) {
      flush(true)
    }
  }

  // No visibilitychange here: it does not exist before IE10, and the prefixed IE10 variant would
  // only cover part of the range this build targets. beforeunload plus unload is what is available
  // everywhere. Flushing empties the buffer, so the second event is a no-op rather than a resend.
  const addEventListener = getZoneJsOriginalValue(window, 'addEventListener')
  addEventListener.call(window, 'beforeunload', onPageExit)
  addEventListener.call(window, 'unload', onPageExit)

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

    stop() {
      stopped = true
      cancelScheduledFlush()
      const removeEventListener = getZoneJsOriginalValue(window, 'removeEventListener')
      removeEventListener.call(window, 'beforeunload', onPageExit)
      removeEventListener.call(window, 'unload', onPageExit)
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
