# RUM Browser SDK — legacy build

A separate, self-contained build of the RUM Browser SDK for browsers without ES2015 support.

The standard bundles are compiled to ES2018 and send over `fetch` / `sendBeacon`. On a browser that
supports neither, the script fails to parse before any code inside it runs, so no amount of feature
detection in the SDK can help. This package is the answer to that: a smaller SDK, compiled to ES5,
that sends over `XMLHttpRequest`.

It is distributed through the CDN only and is not published to npm. Bundling it with an application
would put its output back into a file the browser has to parse as a whole, which is the failure this
build exists to avoid.

## What it collects

| Capability                 | Supported | Notes                                            |
| -------------------------- | :-------: | ------------------------------------------------ |
| Uncaught JavaScript errors |    ✅     | No stack; the script url and line are reported   |
| Page load timings          |    ✅     | From `performance.timing`                        |
| Views                      |    ✅     | Initial load, plus `hashchange` and manual views |
| Manual actions and errors  |    ✅     | `addAction`, `addError`                          |
| Session and user identity  |    ✅     | Same session cookie as the standard bundles      |
| Resource timings           |    ❌     | No Resource Timing API                           |
| Automatic user actions     |    ❌     | Requires DOM observation not available here      |
| Web Vitals, long tasks     |    ❌     | No `PerformanceObserver`                         |
| Session replay             |    ❌     | No `MutationObserver`                            |
| CSP violation reporting    |    ❌     | No `securitypolicyviolation` event               |

Everything unsupported is a no-op method rather than a missing one. A page written against the
standard bundle runs unchanged; it does not need to branch on the browser.

Below the floor — IE6 to IE8 and their document modes, which the loader snippet also routes here —
the promise inverts: nothing is collected, and the bundle's whole evaluation is guarded so the
hosting page stays untouched. `Object.defineProperty` on plain objects, which IE8 rejects, is
guarded individually, and the build gate additionally rejects ES3 reserved words used as property
names, which those engines cannot even parse and no runtime guard could catch.

## Getting the bundles

Released bundles are served from the CDN under a major-version directory:

```
https://static.flashcat.cloud/browser-sdk/v0/fc-rum-legacy.js
https://static.flashcat.cloud/browser-sdk/v0/flashcat-rum.js
```

The directory always holds the latest release of that major version, so re-downloading the same url
is how a self-hosted copy is updated.

Environments that self-host — the norm for the networks this build targets, where the public CDN is
often unreachable at all — should not pick files by hand: the standard RUM bundle loads hash-named
chunk files that must match it exactly. `scripts/deploy/sync-bundles.js` downloads a complete,
coherent set instead:

```bash
node scripts/deploy/sync-bundles.js prod v0 ./cdn-bundles
```

It needs no credentials, fails loudly if any file is missing, and the resulting directory is served
as-is from the hosting origin — the `<static host>` in the snippet below.

## Setup

Both builds share the `FC_RUM` global and the same call sequence, so the page carries one snippet.
The choice is made on capability, not on the user agent string, which means a browser running in a
compatibility document mode is classified by what it can actually do.

```html
<script>
  ;(function (w, d) {
    var legacy = typeof w.Promise !== 'function' || typeof w.fetch !== 'function'
    w.FC_RUM = w.FC_RUM || {
      q: [],
      onReady: function (c) {
        this.q.push(c)
      },
      // Stub so that calling init before the script has landed queues the call instead of throwing
      // "undefined is not a function" and taking the page down with it.
      init: function (o) {
        this.q.push(function () {
          w.FC_RUM.init(o)
        })
      },
    }
    var s = d.createElement('script')
    s.async = true
    s.src = legacy ? 'https://<static host>/fc-rum-legacy.js' : 'https://<static host>/flashcat-rum.js'
    d.getElementsByTagName('head')[0].appendChild(s)
  })(window, document)
</script>
<script>
  window.FC_RUM.onReady(function () {
    window.FC_RUM.init({
      applicationId: '<application id>',
      clientToken: '<client token>',
      proxy: '/rum-intake/',
    })
  })
</script>
```

Calls made before the bundle arrives are queued on `q` and run once it loads. This is the same
mechanism the standard bundles already use. `init` is stubbed on the placeholder for the same
reason: a page that calls it outside `onReady`, before the script has landed, would otherwise hit
`undefined is not a function` — the failure this build exists to prevent.

### `proxy` is required

`proxy` is a path on the page's own origin that the customer's web server forwards to the intake.
It is not optional here, unlike in the standard bundles, because these browsers cannot make a
cross-origin `XMLHttpRequest` carrying the parameters the intake needs. `init` reports the problem
and collects nothing rather than sending requests that would be blocked.

The request is shaped exactly like the one the standard bundles send, so a single reverse proxy rule
serves both and the intake needs no compatibility branch:

```
POST https://<page origin>/rum-intake/?ddforward=<url-encoded /api/v2/rum?...>
```

An nginx rule forwarding it, for example:

```nginx
location /rum-intake/ {
  proxy_pass https://<intake host>/;
}
```

The request declares `Content-Type: text/plain;charset=UTF-8`, which the intake requires. The
standard bundles never declare it because `fetch` and `sendBeacon` set it implicitly for a string
body; `XMLHttpRequest` on these browsers cannot be relied on to do the same. It costs nothing: the
request is same-origin, and `text/plain` is a safelisted value that does not trigger a preflight
even when it is not.

If a Content Security Policy is in force it needs to allow the static host and `connect-src` to the
page's own origin. `unsafe-eval` is not required.

## Configuration

| Option              | Required | Notes                                                                         |
| ------------------- | :------: | ----------------------------------------------------------------------------- |
| `applicationId`     |    ✅    |                                                                               |
| `clientToken`       |    ✅    |                                                                               |
| `proxy`             |    ✅    | Same-origin path forwarded to the intake                                      |
| `service`           |          |                                                                               |
| `version`           |          |                                                                               |
| `env`               |          |                                                                               |
| `sessionSampleRate` |          | 0 to 100, defaults to 100. Decided once per session and carried in the cookie |
| `trackingConsent`   |          | `granted` (default) or `not-granted`; any other value counts as not granted   |

Options that only apply to the standard bundles are accepted and ignored, so one configuration
object can be shared between the two.

## Differences from the standard bundles

Beyond the capability table above, two behaviours differ and are worth knowing before porting a
page:

- `stopSession()` shuts collection down for the rest of the page. In the standard bundles it ends
  the current session and a new one starts on the next interaction. Use `setTrackingConsent` if you
  want collection to be resumable.
- `setViewName()` starts a new view rather than renaming the current one. A view event has already
  been sent under the old name and there is no way to retract it.

Consent is honoured: with `trackingConsent: 'not-granted'` nothing is collected or sent, and
withdrawing consent later drops whatever is buffered and clears the session cookie.

## Development

```bash
yarn build:bundle   # typecheck, bundle, then verify ES5 compatibility
yarn typecheck      # ES5 lib check on its own
```

`tsconfig.json` deliberately does not extend the repository base config. `lib` is restricted to
`ES5` and `DOM` so that using an API the target browsers lack is a compile error rather than a
runtime crash, and `paths` is emptied so `@flashcatcloud/*` imports do not resolve — those packages
are written against ES2018 and importing one would defeat the purpose of this build.

Two checks run as part of the bundle build. `scripts/check-es5-compatibility.js` parses the output
as ES5, scans it for runtime APIs the target browsers lack, and asserts that the standard bundles
are _rejected_, so a broken check cannot pass silently.

`scripts/check-legacy-bundle-runtime.js` then executes the emitted file in a deliberately
impoverished environment — no `fetch`, no `Promise`, no `sendBeacon`, and an `XMLHttpRequest` that
only fires `onreadystatechange` — and asserts what lands on the wire: a synchronous POST, the intake
path and parameters inside `ddforward`, and a payload carrying a view and an error. Every unit spec
runs against TypeScript compiled by the test runner; between that and the shipped file sit Terser
and the webpack runtime, and this is what covers the gap.

## Testing, and what it does not cover

The specs run in a modern headless browser. `src/boot/degradedEnvironment.spec.ts` removes `fetch`,
`Promise`, `MutationObserver`, `PerformanceObserver`, `TextEncoder`, `URL` and `sendBeacon`, and
drives the package end to end through an `XMLHttpRequest` that offers only `onreadystatechange`, as
IE9 does.

The ES2015 collections are deliberately left in place there. `lib: ES5` already makes using them a
compile error, which is stronger than a runtime spec, and the bundle scan covers the emitted output.
Removing them at runtime would only break the test harness, which builds a `Map` of its own around
every listener.

Guarantees that could be asserted vacuously are checked by removing the implementation and
confirming a spec fails: the ES5 gate, the event schema validation, the page exit ordering, the
sampling and consent gates, and the listener guards.

That covers missing runtime APIs and unsupported syntax. The behaviour of the actual engines was
verified separately, on real browsers through a cloud device farm (BrowserStack): IE 9, 10 and 11
pass every check in the verification page below, including the two that only mean anything on a
real Trident engine, and IE 6 and IE 8 were confirmed to degrade to a silent no-op that leaves the
hosting page untouched.

## Verifying on a real browser

`verification/` holds a self-contained harness for exactly that step:

```bash
node packages/rum-legacy/scripts/verification-server.js   # builds are not included: build first
```

Then open `http://localhost:8099/` in the browser under test and press _Run checks_. The page is
plain ES5 and renders every result into the DOM, because the browsers it targets often have no
usable developer tools. The server doubles as a same-origin intake that records what actually
arrived — method, content type, body — so the checks assert the wire, not the SDK's own claims:
the bundle loads, `init` and the collection APIs do not throw into the page, an uncaught error
still reaches the page's own handler, the session cookie is written, and the intake received a
`text/plain` POST whose real path travels inside `ddforward`, carrying a view and an error event.

On Windows, Edge's IE mode (F12 → emulation → document mode 9/10/11) runs the real Trident engine
and is the cheapest meaningful pass; a run on actual IE hardware or a cloud device farm is the
authoritative one. Two checks only have meaning on a real Trident engine, which is precisely why they are in this
page and not only in the unit suite: the content-type assertion passes on any modern browser
regardless of the SDK, because `fetch`-era browsers add the header to a string body implicitly —
and the page-exit assertion shows SKIP on modern engines, which block synchronous XHR during page
dismissal by design.
