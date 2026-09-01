# Changelog

> **Legend**
>
> 💥 - Breaking change.
>
> ✨ - New feature.
>
> 🐛 - Bug fix.
>
> ⚡️ - Performance improvement.
>
> 📝 - Documentation.
>
> ⚗ - Experimental.
>
> See [Gitmoji](https://gitmoji.dev/) for a guide on the emojis used.

---

## Unreleased

- 💥 **Breaking**: `remoteConfigurationId` is gone from `RumInitConfiguration`. It fetched a
  different endpoint under a different contract, and is replaced by `remoteConfigurationEnabled`.
  A site still passing it in JavaScript keeps working and gets the settings it passed to `init`;
  a TypeScript project passing it no longer compiles and should drop the option.
- 📝 Behind a `proxy`, the settings request travels to `/api/v2/rum/config`. A proxy that checks the
  forwarded path against a list of known intake paths must be told about this one, or the settings
  never arrive — the SDK keeps collecting with the values passed to `init`, so the only symptom is
  that the console appears to have no effect.
- 💥 **Breaking for TypeScript code that implements our interfaces**: `RumPublicApi` gains
  `setForcedSession` and `getRemoteConfig`, and `RumSessionManager` gains `setForcedSession`. Code
  that only calls these interfaces is unaffected; code that implements or hand-mocks them needs the
  new members. The two new methods are also absent from the legacy ES5 bundle, so feature-detect
  them if the same code runs against both.
- ✨ `remoteConfigurationEnabled` lets the sampling rates, the trace sample rate and the Session
  Replay privacy level be set from the console instead of only at `init`. Off by default: without
  it the SDK makes no extra request. A change applies to sessions created after it arrives, never
  to one already under way. `remoteConfigurationFetchTimeout` (default 3000 ms) bounds how long
  that request may take; an unusable value falls back to the default rather than refusing `init`.
- 📝 This release reads and writes `localStorage` on every site, not only those that opt into
  remote configuration: the sampling draw a session was created under is recorded there, so that
  another tab on the same session, and the page load that restores it, report and trace it the same
  way. Sessions themselves are unaffected and stay in a cookie unless `sessionPersistence` says
  otherwise. Called out for privacy reviews.
- ✨ `beforeSampling` gives the application the last word on the rates at the moment a session is
  drawn, with the console's custom values in hand.
- ✨ `setForcedSession()` collects the current visitor regardless of the rates, and
  `getRemoteConfig()` returns the console's custom values verbatim.

---

## v0.1.0

This release adds a separate ES5 build of the RUM Browser SDK for browsers without ES2015 support:
`fc-rum-legacy.js`, distributed through the CDN only. It was verified on real IE 9, 10 and 11, and
on IE 6 to IE 8 it loads and stays silent rather than disturbing the page it is on. See
`packages/rum-legacy/README.md` for how to load it, what it collects, and what it does not.

Releases now publish into a directory named for the release, `/browser-sdk/v0.1.0/`, rather than
one named for the major version. A url pins the version it names, and updating a self-hosted copy
means pointing at the next release. `scripts/deploy/sync-bundles.js` downloads a complete set.

**Internal Changes:**

- Merge pull request #27 from flashcatcloud/main
- Merge pull request #26 from flashcatcloud/chore/reconcile-publish-into-main
- test(rum-legacy): stop the time spent measurement drifting [RUM-LEGACY]
- test(rum-legacy): assert the view fields that reach the wire [RUM-LEGACY]
- fix(rum-legacy): survive the checks the merged CI actually runs [RUM-LEGACY]
- fix(deploy): duplicate whole expectations, not just their command line
- fix(deploy): teach the release tooling about the legacy bundle [RUM-LEGACY]
- Merge branch 'publish' into main
- Merge pull request #23 from flashcatcloud/feat/cdn-sync-and-delivery-docs
- Merge pull request #22 from flashcatcloud/feat/rum-legacy-es5
- chore(rum-legacy): satisfy the no-unsafe-return rule in the cookie spec [RUM-LEGACY]
- fix(rum-legacy): keep the session cookie as long as the modern bundle does [RUM-LEGACY]
- fix(rum-legacy): hold the session cookie contract across both builds [RUM-LEGACY]
- fix(deploy): close the paths where the sync gave up quietly
- refactor(deploy): leave the release path alone in the sync script
- fix(deploy): make the bundle sync keep the promise it prints
- fix(rum-legacy): rename the current view instead of starting a new one [RUM-LEGACY]
- fix(rum-legacy): keep stopSession and init to their public contracts [RUM-LEGACY]
- docs(rum-legacy): state what the page exit guard actually promises [RUM-LEGACY]
- docs(rum-legacy): confirm page load timings on IE9 [RUM-LEGACY]
- test(rum-legacy): make the harness answer the page load timing question [RUM-LEGACY]
- docs(rum-legacy): name the remaining divergences from the standard bundle [RUM-LEGACY]
- chore: keep the lockfile change to the dependency this adds
- fix(rum-legacy): make the documented loader route and parse correctly [RUM-LEGACY]
- fix(rum-legacy): stop losing consent, exits and view dates [RUM-LEGACY]
- fix(rum-legacy): write the session cookie the modern bundle can read [RUM-LEGACY]
- docs(rum-legacy): document bundle distribution and real-browser results [RUM-LEGACY]
- feat(deploy): add sync-bundles script to download deployed bundles
- fix(rum-legacy): survive the formatter and the pre-XHR engines in the harness [RUM-LEGACY]
- fix(rum-legacy): harden the verification harness on real Trident engines [RUM-LEGACY]
- feat(rum-legacy): guarantee silence on engines below the support floor [RUM-LEGACY]
- fix(rum-legacy): make the verification run fit a metered device session [RUM-LEGACY]
- feat(rum-legacy): add a real-browser verification harness [RUM-LEGACY]
- fix(rum-legacy): declare the content type the intake requires [RUM-LEGACY]
- fix(rum-legacy): reject a non-numeric sample rate, keep foreign cookie fields [RUM-LEGACY]
- fix(rum-legacy): copy context and configuration on the way in as well [RUM-LEGACY]
- fix(rum-legacy): recognise errors from other frames, stop leaking state [RUM-LEGACY]
- fix(rum-legacy): correct wall-clock durations, exit ordering and session reuse [RUM-LEGACY]
- fix(rum-legacy): guard browser callbacks and fix in-page referrer [RUM-LEGACY]
- fix(rum-legacy): apply sessionSampleRate and honour trackingConsent [RUM-LEGACY]
- fix(rum-legacy): send a closing view update when the page unloads [RUM-LEGACY]
- refactor(rum-legacy): remove duplicated object and error helpers [RUM-LEGACY]
- test(rum-legacy): verify behaviour without the modern browser APIs [RUM-LEGACY]
- feat(rum-legacy): expose the full public API surface [RUM-LEGACY]
- feat(rum-legacy): collect errors, page load timings and views [RUM-LEGACY]
- feat(rum-legacy): send batched events over XMLHttpRequest [RUM-LEGACY]
- feat(rum-legacy): add ES5 build target and compatibility gate [RUM-LEGACY]
- Merge pull request #21 from flashcatcloud/fix/tag-triggered-release
- fix(ci): make a pushed tag actually release again
- Merge pull request #16 from flashcatcloud/fix/replay-intake-hardcoded-ip
- fix(core): hardcode public staging intake host jira.flashcat.cloud [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- fix(core): remove hardcoded internal staging IP from intake sites [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]

## v0.0.7

**Internal Changes:**

- Merge pull request #19 from flashcatcloud/fix/ts7-compat-toolchain
- fix(ci): let package install scripts run again
- fix(ci): keep the yarn upgrade to the yarn path
- fix(ci): migrate the lockfile to the format the new yarn writes
- fix(ci): unblock releases from TypeScript 7
- Merge pull request #18 from flashcatcloud/feat/renderer-replay-direct-upload-publish
- fix(rum): stop collecting for the host while it has no session [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- docs: state what an empty host identifier means on the bridge [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- docs: make the FLASHCAT FORK markers name the right change [RUM] [RUM-REACT] [RUM-SLIM]
- fix(rum): keep intake credentials and stop backfilling usr.id under a host bridge [RUM] [RUM-REACT] [RUM-SLIM]
- feat(rum): keep collecting Session Replay in the page when a host bridge is present [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]

## v0.0.6

**Public Changes:**

- ✨ Add `trackWebVitals` configuration option to opt out of initial view (Web Vitals) metrics — FCP, LCP, FID and loading time. Disable it (`trackWebVitals: false`) for pages loaded in the background or pre-warmed (e.g. a hidden Electron window), where these metrics would otherwise be measured from an irrelevant navigation start and reported as abnormally large values. Defaults to `true`, so existing behavior is unchanged. ([#15](https://github.com/flashcatcloud/browser-sdk/pull/15)) [RUM] [RUM-REACT] [RUM-SLIM]

**Internal Changes:**

- Merge pull request #15 from flashcatcloud/feat/track-web-vitals

## v0.0.5

**Internal Changes:**

- Merge pull request #14 from flashcatcloud/fix/ci-baseline-followup
- test(e2e): use latest view update per view id in init scenario
- fix: CI baseline follow-up — replay focus misfire, BUILD_MODE leak, PATH precedence [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- Merge pull request #13 from flashcatcloud/chore/release-safety-automation
- test(logs): expect default usr.id from anonymous id in request spec [LOGS]
- Merge remote-tracking branch 'origin/publish' into chore/release-safety-automation
- Merge pull request #12 from flashcatcloud/feat/replay-resnapshot-on-reactivation
- chore: restore release safety baseline [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- test(replay): drive debounce test from REACTIVATE_DEBOUNCE constant [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- feat(replay): take a subsequent full snapshot on page re-activation [RUM]
- feat(replay): flush replay segment on page re-activation [RUM]
- feat(replay): add PAGE_REACTIVATED lifecycle event and bridge [RUM] [RUM-REACT] [RUM-SLIM]
- feat(replay): add createPageActivationObservable for inactive->active detection [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- Merge branch 'main' into publish
- feat: 跳过cdn发布

## v0.0.4-alpha.2

**Internal Changes:**

- Modified "Feat/session replay ([#8](https://github.com/DataDog/browser-sdk/pull/8))" ([#10](https://github.com/DataDog/browser-sdk/pull/10)) [RUM]

## v0.0.4-alpha.1

**Internal Changes:**

- chore: publish bugfix ([#9](https://github.com/DataDog/browser-sdk/pull/9))
- Feat/session replay ([#8](https://github.com/DataDog/browser-sdk/pull/8)) [RUM]

## v0.0.3-beta.2

**Internal Changes:**

- update v6.8.0

## v0.0.2

**Internal Changes:**

- rename flashcat [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]

## v0.0.1

**Internal Changes:**

- init sdk
