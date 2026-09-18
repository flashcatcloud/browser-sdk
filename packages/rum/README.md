# RUM Browser Monitoring

Flashcat Real User Monitoring (RUM) enables you to visualize and analyze the real-time performance and user journeys of your application's individual users.

See the [dedicated flashcat documentation][1] for more details.

## Usage

To start collecting events, add [`@flashcatcloud/browser-rum`][2] to your `package.json` file, then initialize it with:

```javascript
import { flashcatRum } from '@flashcatcloud/browser-rum'

flashcatRum.init({
  applicationId: '<FC_APPLICATION_ID>',
  clientToken: '<FC_CLIENT_TOKEN>',
  site: '<FC_SITE>',
  //  service: 'my-web-application',
  //  env: 'production',
  //  version: '1.0.0',
  sessionSampleRate: 100,
  sessionReplaySampleRate: 100,
  trackResources: true,
  trackLongTasks: true,
  trackUserInteractions: true,
})
```

**Note**: The `trackUserInteractions` parameter enables the automatic collection of user clicks in your application. **Sensitive and private data** contained in your pages may be included to identify the elements interacted with.

<!-- Note: all URLs should be absolute -->

[1]: https://docs.flashcat.cloud/zh/flashduty/rum/introduction
[2]: https://www.npmjs.com/package/@flashcatcloud/browser-rum

## Enabling error session collection across pages

`sessionReplayOnError` needs the full `browser-rum` bundle. The slim and legacy
bundles do not contain a recorder. `sessionOnError` also requires a bundle with
conditional event buffering; the legacy bundle can only honor a shared session
that has already been released by a compatible modern page.

Before enabling either option in initialization or remote configuration:

1. Deploy compatible SDK bundles to every page sharing the session cookie,
   including other applications and subdomains when cross-subdomain tracking is
   enabled. Keep both error-collection options disabled during this deployment.
2. Account for already-open pages and cached application assets. Publishing a new
   SDK does not replace JavaScript in those pages. Require those pages to reload,
   or defer enablement until incompatible pages no longer share the session store.
3. Verify navigation and concurrent tabs using the deployed bundles. A session
   must keep its identity and conditional decision until an error or explicit
   force releases it. Verify that sessions without either trigger upload no
   conditional data.
4. Enable the options only after that compatibility check. Before rolling back to
   an incompatible bundle, disable conditional collection and end or drain the
   existing conditional sessions across the affected pages. Disabling an option
   alone does not rewrite every running session's decision.

Older modern bundles recognize only session tracking values `0`, `1`, and `2`.
They can redraw conditional values `3`, `4`, or `5`, causing unexpected collection
or data loss. The compatible legacy reader recognizes `3` and released `4`/`5`,
but it cannot recover history it never recorded. A browser cannot guarantee
cross-page persistence if its shared store stays locked or becomes unavailable
until the page closes; the SDK retries missing marks through its existing session
poll while that same session remains active.
