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
  command`yarn lerna publish from-package --yes`.withEnvironment({ NPM_TOKEN: process.env.NPM_TOKEN }).run()
})
