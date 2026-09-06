'use strict'

const fs = require('fs')
const path = require('path')
const { printLog, runMain } = require('./lib/executionUtils')
const { command } = require('./lib/command')

const TEST_APP_DIR = path.join(__dirname, '..', 'test', 'apps', 'vanilla')
const TEST_APP_MUTATED_FILES = ['package.json', 'tsconfig.json', 'yarn.lock'].map((file) =>
  path.join(TEST_APP_DIR, file)
)

runMain(() => {
  printLog('Building project...')
  command`yarn build`.run()
  command`lerna run pack --stream`.run()

  printLog('Setting up test environment...')
  command`yarn install --no-immutable`.withCurrentWorkingDirectory(TEST_APP_DIR).run()
  const testAppSnapshot = snapshotFiles(TEST_APP_MUTATED_FILES)

  // TypeScript 7 removed `target: es5` and `moduleResolution: node10`, the two options the test
  // app's tsconfig is built on. A consumer on a current TypeScript cannot express that
  // configuration at all, so checking our type definitions against it there would be checking a
  // setup nobody can have. These are what such a consumer uses instead, and what this app already
  // is — a bundler-resolved web app — at the oldest target still available, which keeps the point
  // of the older checks: that the definitions survive a low target.
  const currentTypeScriptOptions = {
    target: 'es2015',
    module: 'preserve',
    moduleResolution: 'bundler',
  }

  const checks = [
    {
      title: 'TypeScript 3.8.2 compatibility',
      version: '3.8.2',
    },
    {
      title: 'TypeScript isolated modules compatibility',
      compilerOptions: { isolatedModules: true },
      version: '3.8.2',
    },
    {
      title: 'TypeScript 4.1.6 compatibility',
      version: '4.1.6',
    },
    {
      title: 'TypeScript latest compatibility',
      compilerOptions: currentTypeScriptOptions,
      version: 'latest',
    },
    {
      title: 'exactOptionalPropertyTypes compatibility',
      version: 'latest', // Not available in 3.8.2
      compilerOptions: { ...currentTypeScriptOptions, exactOptionalPropertyTypes: true },
    },
    {
      title: 'ESNext compatibility',
      version: 'latest',
      compilerOptions: { ...currentTypeScriptOptions, lib: ['ESNext', 'DOM'] },
    },
  ]

  for (const { title, compilerOptions, version } of checks) {
    printLog(`Checking ${title}...`)
    if (compilerOptions) {
      modifyTestAppConfig(compilerOptions)
    }
    command`yarn add --dev typescript@${version}`.withCurrentWorkingDirectory(TEST_APP_DIR).run()
    try {
      command`yarn compat:tsc`.withCurrentWorkingDirectory(TEST_APP_DIR).run()
    } catch (error) {
      throw new Error(`${title} compatibility broken`, { cause: error })
    } finally {
      restoreFiles(testAppSnapshot)
    }
  }

  printLog('All TypeScript compatibility checks passed.')
})

function modifyTestAppConfig(partialCompilerOptions) {
  const configPath = path.join(TEST_APP_DIR, 'tsconfig.json')
  const originalConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  fs.writeFileSync(
    configPath,
    JSON.stringify({ compilerOptions: { ...originalConfig.compilerOptions, ...partialCompilerOptions } }, null, 2)
  )
}

function snapshotFiles(filePaths) {
  return new Map(
    filePaths.map((filePath) => [
      filePath,
      fs.existsSync(filePath) ? { exists: true, content: fs.readFileSync(filePath, 'utf8') } : { exists: false },
    ])
  )
}

function restoreFiles(snapshot) {
  for (const [filePath, fileSnapshot] of snapshot) {
    if (fileSnapshot.exists) {
      fs.writeFileSync(filePath, fileSnapshot.content)
    } else if (fs.existsSync(filePath)) {
      fs.rmSync(filePath)
    }
  }
}
