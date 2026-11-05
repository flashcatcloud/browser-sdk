const fs = require('fs')
const { printLog, runMain } = require('../lib/executionUtils')
const { command } = require('../lib/command')

runMain(() => {
  printLog('Building the project')
  command`yarn build`.withEnvironment({ BUILD_MODE: 'release' }).run()
  if (!process.env.NPM_TOKEN) {
    throw new Error('NPM_TOKEN is not set')
  }
  printLog('Publishing')
  fs.writeFileSync('.npmrc', `//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}`)
  // A prerelease must never land on the default `latest` tag: publish 0.5.0-beta.1 under
  // `beta` (0.5.0-alpha.1 under `alpha`, ...), like the historical alpha/beta releases.
  const version = JSON.parse(fs.readFileSync('lerna.json', 'utf8')).version
  const prerelease = /-([0-9A-Za-z]+)\./.exec(version)
  const publishCommand = prerelease
    ? command`yarn lerna publish from-package --yes --dist-tag ${prerelease[1]}`
    : command`yarn lerna publish from-package --yes`
  publishCommand.withEnvironment({ NPM_TOKEN: process.env.NPM_TOKEN }).run()
})
