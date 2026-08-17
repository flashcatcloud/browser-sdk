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
 * The content type is declared explicitly. The intake rejects anything that is not text/plain, and
 * while fetch and sendBeacon set it implicitly for a string body — which is why the standard
 * bundles never declare it — XMLHttpRequest on these browsers cannot be relied on to do the same.
 * Declaring it costs nothing: this request is same origin, and text/plain is a safelisted value
 * that does not trigger a preflight even when it is not.
 */
export function createHttpRequest(buildUrl: () => string, onResponse?: (status: number) => void): HttpRequest {
  function request(data: string, isAsync: boolean): void {
    // The host page must keep working even if the SDK cannot report anything at all, so every
    // failure mode here is swallowed: the constructor throwing, a blocked cross-origin send, a
    // security error on an unloading document.
    try {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', buildUrl(), isAsync)
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8')

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
