export interface HttpRequest {
  send: (data: string) => void
  sendOnExit: (data: string) => void
}

/*
 * Transport for browsers with neither fetch nor sendBeacon.
 *
 * Two constraints shape this:
 *   - completion is detected through onreadystatechange. IE9 gained onload only in IE10, so a
 *     transport built on onload would never report a response there.
 *   - the exit path is a synchronous request. Without sendBeacon there is no way to hand a payload
 *     to the browser and let the document go, so the last batch is sent inline while the page is
 *     unloading.
 *
 * No request header is set, keeping the request a "simple request" and matching what the modern
 * bundle sends: the intake reads newline separated json without relying on a content type.
 */
export function createHttpRequest(buildUrl: () => string, onResponse?: (status: number) => void): HttpRequest {
  function request(data: string, isAsync: boolean): void {
    // The host page must keep working even if the SDK cannot report anything at all, so every
    // failure mode here is swallowed: the constructor throwing, a blocked cross-origin send, a
    // security error on an unloading document.
    try {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', buildUrl(), isAsync)

      if (onResponse) {
        xhr.onreadystatechange = function () {
          if (xhr.readyState === 4) {
            try {
              onResponse(xhr.status)
            } catch {
              // A broken response handler is still our problem, not the page's.
            }
          }
        }
      }

      xhr.send(data)
    } catch {
      // Intentionally silent: reporting a monitoring failure must never become a page failure.
    }
  }

  return {
    send(data: string) {
      request(data, true)
    },
    sendOnExit(data: string) {
      request(data, false)
    },
  }
}
