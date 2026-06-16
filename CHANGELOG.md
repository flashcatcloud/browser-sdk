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
