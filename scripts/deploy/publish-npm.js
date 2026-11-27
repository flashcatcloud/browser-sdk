const fs = require('fs')
const { browserSdkVersion } = require('../lib/browserSdkVersion')
const { printLog, runMain } = require('../lib/executionUtils')
const { command } = require('../lib/command')

// Prereleases must never land on npm's default `latest` dist-tag: route `0.7.0-beta.1` to `beta`,
// `0.7.0-rc.1` to `rc`, etc., and fall back to `prerelease` for numeric or `latest` identifiers.
function getDistTag(version) {
  const withoutBuild = version.split('+')[0]
  const dashIndex = withoutBuild.indexOf('-')
  if (dashIndex === -1) {
    return undefined
  }
  const prerelease = withoutBuild.slice(dashIndex + 1)
  const match = /^([A-Za-z][0-9A-Za-z]*)/.exec(prerelease)
  const tag = match ? match[1] : undefined
  if (!tag || tag.toLowerCase() === 'latest') {
    return 'prerelease'
  }
  return tag
}

if (require.main === module) {
  runMain(() => {
    printLog('Building the project')
    command`yarn build`.withEnvironment({ BUILD_MODE: 'release' }).run()
    if (!process.env.NPM_TOKEN) {
      throw new Error('NPM_TOKEN is not set')
    }
    const distTag = getDistTag(browserSdkVersion)
    const distTagArgs = distTag ? ['--dist-tag', distTag] : []

    printLog(
      distTag ? `Publishing ${browserSdkVersion} under dist-tag "${distTag}"` : `Publishing ${browserSdkVersion}`
    )
    fs.writeFileSync('.npmrc', `//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}`)
    command`yarn lerna publish from-package --yes ${distTagArgs}`
      .withEnvironment({ NPM_TOKEN: process.env.NPM_TOKEN })
      .run()
  })
}

module.exports = {
  getDistTag,
}
