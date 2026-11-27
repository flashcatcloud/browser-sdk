# Release Guide

All npm and CDN releases go through a single automated path: tagging a commit with `v*` and pushing
the tag triggers `.github/workflows/deploy-auto.yml`.

## Prerequisites

- A clean checkout on the latest `publish` branch (do not release from `main`).
- Push permission to `origin` for branches and `v*` tags.

## Cutting a Release

```bash
git checkout publish
git pull --ff-only origin publish
yarn install --immutable
yarn release
```

`yarn release` runs `lerna version --exact --force-publish` and:

1. Prompts for the next version — pick a full version (`0.7.0`) or a prerelease (`0.7.0-beta.1`,
   `0.7.0-rc.1`).
2. Updates `CHANGELOG.md` and opens it in your editor (`git var GIT_EDITOR`, `$VISUAL`, or `$EDITOR`).
3. Updates package versions, peer dependencies, `lerna.json`, and lockfiles.
4. Commits the version bump, creates the `v<version>` tag, and pushes both to `origin`.

## What the Pipeline Does

Pushing a `v*` tag triggers **Automatic Deployment** (`.github/workflows/deploy-auto.yml`):

1. **Release preflight**: verifies the tag matches `lerna.json` and `HEAD`, runs `yarn format`,
   `yarn build`, `yarn lint`, `scripts/check-packages.js`, `yarn typecheck`, unit tests, TypeScript
   and SSR compatibility checks, builds the release bundles, and verifies ES5 compatibility.
2. **CDN deployment (`deploy-prod`)**: uploads the verified bundles to OSS under
   `https://static.flashcat.cloud/browser-sdk/v<version>/`.
   - Full releases (`vX.Y.Z`): if `<version>` is the highest published full release, also updates
     `https://static.flashcat.cloud/browser-sdk/latest/` and refreshes the CDN directory cache.
   - Prereleases (`vX.Y.Z-beta.1`, etc.): uploads only to `/browser-sdk/v<version>/` and leaves
     `latest` untouched.
3. **npm publish (`publish-npm`)**: publishes all public `@flashcatcloud/*` packages from the tagged
   commit.
   - Full releases publish under npm's default `latest` dist-tag.
   - Prereleases publish under their prerelease identifier dist-tag (e.g. `0.7.0-beta.1` ->
     `--dist-tag beta`) and never overwrite npm `latest`.
4. **Notifications**: sends success or failure status notifications when the workflow completes.

## Post-Release Verification

Replace `<version>` with the released version (without the leading `v`, e.g. `0.7.0` or
`0.7.0-beta.1`):

```bash
# 1. npm package is published and resolvable
npm view @flashcatcloud/browser-rum@<version> version

# 2. Versioned CDN bundle returns HTTP 200
curl -sfI "https://static.flashcat.cloud/browser-sdk/v<version>/flashcat-rum.js" | head -n 1

# 3. Negative control: a non-existent version returns HTTP 404
curl -sI "https://static.flashcat.cloud/browser-sdk/v0.0.0-nonexistent/flashcat-rum.js" | head -n 1
```

For full releases, also confirm `https://static.flashcat.cloud/browser-sdk/latest/flashcat-rum.js`
serves the new version once the CDN cache refresh completes (typically a few minutes).

## Staging Preview

To test bundles before cutting a release tag, run the **Staging Deployment** workflow
(`.github/workflows/deploy-staging.yml`) manually via GitHub Actions `workflow_dispatch` on your
branch. It deploys only to `https://static.flashcat.cloud/browser-sdk-staging/v<version>/` and does
not publish to npm.

## Handling a Failed Release

Do not force-push or move a tag that has already been pushed. Fix the issue on `publish` and cut the
next patch or prerelease version with `yarn release`.
