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

## v0.0.3-beta.1

**Public Changes:**

- 🐛 [RUM-10101] Persist session cookie to one year when opt-in anonymous user tracking ([#3559](https://github.com/DataDog/browser-sdk/pull/3559)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]

**Internal Changes:**

- 🔧 add flagging path to tsconfig ([#3566](https://github.com/DataDog/browser-sdk/pull/3566))

## v0.0.3-beta.0

**Public Changes:**

- ✨ Allow overriding service and version for views events in beforeSend ([#3530](https://github.com/DataDog/browser-sdk/pull/3530)) [RUM] [RUM-REACT] [RUM-SLIM]
- ✨ Add developer extension support for replay sandbox local development ([#3511](https://github.com/DataDog/browser-sdk/pull/3511))
- ✨ Add publicPath configuration to webpack setups ([#3488](https://github.com/DataDog/browser-sdk/pull/3488)) [LOGS] [RUM-SLIM] [RUM] [WORKER]
- ✨ Allow to retrieve records in the developer-extension Replay tab ([#3482](https://github.com/DataDog/browser-sdk/pull/3482))
- ✨ [RUM-9302] Page state consolidation ([#3454](https://github.com/DataDog/browser-sdk/pull/3454)) [RUM] [RUM-REACT] [RUM-SLIM]
- ✨ Update TypeScript configuration for e2e tests to include 'noEmit' option ([#3437](https://github.com/DataDog/browser-sdk/pull/3437))
- 🐛 [devext] synchronize network rules on extension start ([#3560](https://github.com/DataDog/browser-sdk/pull/3560))
- 🐛 [RUM-9738] quickfix switchToAbsoluteUrl ([#3518](https://github.com/DataDog/browser-sdk/pull/3518)) [RUM]
- 🐛 [devext] fix "Use development bundle on NPM setup" ([#3502](https://github.com/DataDog/browser-sdk/pull/3502)) [LOGS] [RUM-SLIM] [RUM] [WORKER]
- 🐛 [RUM-9465] Add support for parsing Safari Wasm stack trace ([#3481](https://github.com/DataDog/browser-sdk/pull/3481)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- 🐛 Add profiler chunk URL to redirect rules and constants ([#3485](https://github.com/DataDog/browser-sdk/pull/3485))
- 🐛 Improve context properties sanitization ([#3475](https://github.com/DataDog/browser-sdk/pull/3475)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- 🐛 Add missing original error for beforeSend context ([#3442](https://github.com/DataDog/browser-sdk/pull/3442)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- 🐛 fix TypeScript 4 compatibility ([#3448](https://github.com/DataDog/browser-sdk/pull/3448)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- 🐛 [RUM-99] don't stop RUM/Replay on beforeunload ([#3406](https://github.com/DataDog/browser-sdk/pull/3406)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- 🐛 [RUM-8606] Track First Hidden before init ([#3391](https://github.com/DataDog/browser-sdk/pull/3391)) [RUM] [RUM-REACT] [RUM-SLIM]
- ⚡️ Remove customer data track for perf and bundle size ([#3393](https://github.com/DataDog/browser-sdk/pull/3393)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- Revert "⚡️ use `import()` for lazy loading chunks ([#3399](https://github.com/DataDog/browser-sdk/pull/3399))" ([#3440](https://github.com/DataDog/browser-sdk/pull/3440))
- 📝 mention missing `compressIntakeRequests` support in rum-slim readme ([#3531](https://github.com/DataDog/browser-sdk/pull/3531)) [RUM-SLIM]
- 📝 [RUM-7705] Add js doc about option that need to be aligned ([#3410](https://github.com/DataDog/browser-sdk/pull/3410)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]

**Internal Changes:**

- 👷 [FFL-23] Create datadog-flagging package ([#3553](https://github.com/DataDog/browser-sdk/pull/3553)) [FLAGGING]
- 👷️ [RUM-9996] fix internal source maps upload for root upload type ([#3544](https://github.com/DataDog/browser-sdk/pull/3544))
- 👷 Update all non-major dependencies ([#3539](https://github.com/DataDog/browser-sdk/pull/3539)) [RUM-REACT]
- 👷️[RUM-9996] Support deployment for ap2 datacenter ([#3538](https://github.com/DataDog/browser-sdk/pull/3538))
- 👷 Lock file maintenance ([#3526](https://github.com/DataDog/browser-sdk/pull/3526))
- 👷️enable renovate `lockFileMaintenance` ([#3525](https://github.com/DataDog/browser-sdk/pull/3525))
- 👷️Bump nx resolution ([#3523](https://github.com/DataDog/browser-sdk/pull/3523))
- 👷 Update mantine monorepo to v8 ([#3521](https://github.com/DataDog/browser-sdk/pull/3521))
- 👷 Update all non-major dependencies ([#3520](https://github.com/DataDog/browser-sdk/pull/3520)) [RUM-REACT] [WORKER]
- 👷 Update all non-major dependencies ([#3515](https://github.com/DataDog/browser-sdk/pull/3515)) [RUM-REACT]
- 👷 Update dependency eslint-plugin-unicorn to v59 ([#3504](https://github.com/DataDog/browser-sdk/pull/3504))
- 👷 Update all non-major dependencies ([#3503](https://github.com/DataDog/browser-sdk/pull/3503)) [RUM-REACT] [WORKER]
- 👷️scripts: extract test:e2e:init ([#3501](https://github.com/DataDog/browser-sdk/pull/3501))
- 👷 Update PR template ([#3490](https://github.com/DataDog/browser-sdk/pull/3490))
- 👷 Update dependency express to v5 ([#3473](https://github.com/DataDog/browser-sdk/pull/3473))
- 👷 Update all non-major dependencies ([#3495](https://github.com/DataDog/browser-sdk/pull/3495)) [RUM-REACT] [WORKER]
- 👷 Update all non-major dependencies ([#3472](https://github.com/DataDog/browser-sdk/pull/3472)) [RUM-REACT] [WORKER]
- 👷 Enable timestamps for GitLab CI logs in configuration ([#3462](https://github.com/DataDog/browser-sdk/pull/3462))
- 👷 Update chunk name formatting to use underscore instead of dash ([#3483](https://github.com/DataDog/browser-sdk/pull/3483))
- 👷 use dash instead of dot for joining chunk name in size stats ([#3474](https://github.com/DataDog/browser-sdk/pull/3474))
- 👷 [RUM-9370] Remove unused code ([#3470](https://github.com/DataDog/browser-sdk/pull/3470)) [RUM] [RUM-REACT] [RUM-SLIM]
- 👷 add lazy loaded bundles sizes ([#3468](https://github.com/DataDog/browser-sdk/pull/3468))
- 👷 Filter out package.json files from test/apps directory in release check script ([#3466](https://github.com/DataDog/browser-sdk/pull/3466))
- 👷 [RUM-8159] E2E test for the react integration ([#3428](https://github.com/DataDog/browser-sdk/pull/3428))
- 👷 Bump chrome to 135.0.7049.52-1 ([#3458](https://github.com/DataDog/browser-sdk/pull/3458))
- 👷 [RUM-259] update test/app to use local tarballs ([#3335](https://github.com/DataDog/browser-sdk/pull/3335)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- 👷 Update dependency eslint-plugin-unicorn to v58 ([#3452](https://github.com/DataDog/browser-sdk/pull/3452))
- 👷 Update all non-major dependencies ([#3451](https://github.com/DataDog/browser-sdk/pull/3451)) [RUM-REACT]
- 👷 Update all non-major dependencies ([#3438](https://github.com/DataDog/browser-sdk/pull/3438)) [RUM-REACT]
- 👷 [RUM-105] use local dev server for local e2e tests ([#3420](https://github.com/DataDog/browser-sdk/pull/3420))
- 👷 Enable the Terser 'unsafe' option ([#3418](https://github.com/DataDog/browser-sdk/pull/3418))
- 👷 Update all non-major dependencies ([#3408](https://github.com/DataDog/browser-sdk/pull/3408)) [RUM-REACT]
- 🔧 apply sourcemaps to unit tests common chunk ([#3545](https://github.com/DataDog/browser-sdk/pull/3545))
- 🔧 [RUM-9766] include bundle chunks in NPM packages ([#3513](https://github.com/DataDog/browser-sdk/pull/3513)) [LOGS] [RUM-SLIM] [RUM] [WORKER]
- ✅ hide unexpected unit test logs ([#3486](https://github.com/DataDog/browser-sdk/pull/3486)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- 👌 [RUM-99] don't set views as inactive when the page is exiting ([#3446](https://github.com/DataDog/browser-sdk/pull/3446)) [RUM] [RUM-REACT] [RUM-SLIM]
- fix: version error [LOGS]
- Merge branch 'main' into publish
- fix: test build error
- del: test/app
- feat: update lock
- Merge branch 'main' into publish
- Merge branch main of github.com:flashcatcloud/browser-sdk [RUM] [RUM-REACT] [RUM-SLIM]
- feat: update yarn.lock
- Merge pull request #6 from flashcatcloud/feat/default_usrId
- fix: init [FLAGGING]
- feat: add default usrId [LOGS] [RUM] [RUM-REACT] [RUM-SLIM]
- Merge branch 'main' of github.com:flashcatcloud/browser-sdk
- feat: fork datadog sdk [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- Add Workflow: Changelog To Confluence ([#3546](https://github.com/DataDog/browser-sdk/pull/3546))
- ♻️ [RUM-9990] Use hooks for Logs SDK to decouple rumInternalContext ([#3537](https://github.com/DataDog/browser-sdk/pull/3537)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- Remove FF for adding user account baggage header ([#3547](https://github.com/DataDog/browser-sdk/pull/3547)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- ⚗ [RUM-7213] DOM mutation ignoring ([#3276](https://github.com/DataDog/browser-sdk/pull/3276)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- Add dd trusted to extension visibilityChange events ([#3536](https://github.com/DataDog/browser-sdk/pull/3536))
- ♻️ [RUM-9614] Decouple default context from assembly using hooks ([#3498](https://github.com/DataDog/browser-sdk/pull/3498)) [RUM] [RUM-REACT] [RUM-SLIM]
- [RUM Profiler] Use clocks for start/end time ([#3510](https://github.com/DataDog/browser-sdk/pull/3510)) [RUM]
- ⚗ Add experimental feature flag to enable intake request tracking ([#3509](https://github.com/DataDog/browser-sdk/pull/3509)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- Bump replay sandbox to 0.119.0 ([#3508](https://github.com/DataDog/browser-sdk/pull/3508))
- ♻️ [RUM-9667] refactor stack trace computation ([#3499](https://github.com/DataDog/browser-sdk/pull/3499)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- ⚗️️✨️[RUM-9672] trace baggage: rename `usr` to `user` ([#3505](https://github.com/DataDog/browser-sdk/pull/3505)) [RUM] [RUM-REACT] [RUM-SLIM]
- ♻️ [RUM-9549] Decouple the session context from assembly using hooks ([#3489](https://github.com/DataDog/browser-sdk/pull/3489)) [RUM] [RUM-REACT] [RUM-SLIM]
- 🔥 Remove url missing telemetry ([#3497](https://github.com/DataDog/browser-sdk/pull/3497)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- ♻️trackCumulativeLayoutShift: Return the source with the biggest impacting area [RUM] [RUM-REACT] [RUM-SLIM]
- ♻️ Decouple the connectivity context from assembly using hooks ([#3494](https://github.com/DataDog/browser-sdk/pull/3494)) [RUM] [RUM-REACT] [RUM-SLIM]
- ♻️ Decouple the display context from assembly using hooks ([#3493](https://github.com/DataDog/browser-sdk/pull/3493)) [RUM] [RUM-REACT] [RUM-SLIM]
- [RUM-8527] remove react doc ([#3487](https://github.com/DataDog/browser-sdk/pull/3487)) [RUM-REACT]
- ⚗️ ✨ [RUM-8365] Propagate session id in `baggage` header ([#3430](https://github.com/DataDog/browser-sdk/pull/3430)) [RUM] [RUM-REACT] [RUM-SLIM]
- ♻️ [RUM-8767] Use assembly hooks for global, user and account context ([#3457](https://github.com/DataDog/browser-sdk/pull/3457)) [RUM] [RUM-REACT] [RUM-SLIM]
- use baggage for user.id / account.id forwarding ([#3445](https://github.com/DataDog/browser-sdk/pull/3445)) [RUM] [RUM-REACT] [RUM-SLIM]
- Lazy load profiler error handling + simplify profilerAPI ([#3460](https://github.com/DataDog/browser-sdk/pull/3460)) [RUM]
- 🧹 Update .npmignore to include react-router 7 ([#3464](https://github.com/DataDog/browser-sdk/pull/3464)) [RUM-REACT]
- [RUM Profiler] Fix collection of profiles after visibility change ([#3459](https://github.com/DataDog/browser-sdk/pull/3459)) [RUM]
- ♻️ Refactor cookieObservable to not rely on cookieStore ([#3456](https://github.com/DataDog/browser-sdk/pull/3456)) [RUM] [RUM-REACT] [RUM-SLIM]
- [RUM Profiler] Improvements around Views and Long Tasks ([#3450](https://github.com/DataDog/browser-sdk/pull/3450)) [RUM]
- ♻️ [RUM-9126] Decouple common contexts from rumPublicApi ([#3432](https://github.com/DataDog/browser-sdk/pull/3432)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- ♻️ [RUM-8795] Replace XHR with Fetch for HTTP requests ([#3417](https://github.com/DataDog/browser-sdk/pull/3417)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- [Experimental][RUM Profiler] Integrate Profiler into SDK ([#3340](https://github.com/DataDog/browser-sdk/pull/3340)) [FLAGGING] [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]
- 🚨 [RUM-8945] add a rule to make sure we don't import dev deps in prod files ([#3412](https://github.com/DataDog/browser-sdk/pull/3412))

## v0.0.2

**Internal Changes:**

- rename flashcat [LOGS] [RUM] [RUM-REACT] [RUM-SLIM] [WORKER]

## v0.0.1

**Internal Changes:**

- init sdk
