'use strict'

const fs = require('fs')
const path = require('path')
const acorn = require('acorn')
const { printLog, printError, runMain } = require('./lib/executionUtils')

const ROOT_DIR = path.join(__dirname, '..')

/**
 * The legacy bundle targets browsers without ES2015 support, so it must parse as ES5. Nothing but a
 * parser can tell us that: a single arrow function or `const` left anywhere in the output makes the
 * whole script fail to load, before any feature detection inside the SDK gets a chance to run.
 *
 * The modern bundles are checked the other way around. If a configuration mistake made the parser
 * accept everything, the ES5 assertion below would still pass and the gate would silently stop
 * protecting anything. Asserting that the modern bundles are rejected keeps the gate honest.
 */
const EXPECTED_ES5 = ['packages/rum-legacy/bundle/fc-rum-legacy.js']

const EXPECTED_NOT_ES5 = ['packages/rum/bundle/flashcat-rum.js', 'packages/rum-slim/bundle/flashcat-rum-slim.js']

runMain(() => {
  const failures = []

  for (const relativePath of EXPECTED_ES5) {
    const result = parseAsEs5(relativePath)
    if (result.missing) {
      failures.push(`${relativePath}: not found, build it before running this check`)
    } else if (result.error) {
      failures.push(`${relativePath}: expected to parse as ES5, but failed at ${formatError(result.error)}`)
    } else {
      printLog(`✅ ${relativePath} parses as ES5`)
    }
  }

  for (const relativePath of EXPECTED_NOT_ES5) {
    const result = parseAsEs5(relativePath)
    if (result.missing) {
      printLog(`⏭️  ${relativePath} not built, skipping self-check`)
    } else if (result.error) {
      printLog(`✅ ${relativePath} is rejected as ES5, the check is able to detect newer syntax`)
    } else {
      failures.push(
        `${relativePath}: parsed as ES5, which is impossible for an ES2018 bundle. The ES5 check is not working.`
      )
    }
  }

  if (failures.length > 0) {
    printError('ES5 compatibility check failed:')
    for (const failure of failures) {
      printError(`  - ${failure}`)
    }
    process.exit(1)
  }
})

function parseAsEs5(relativePath) {
  const absolutePath = path.join(ROOT_DIR, relativePath)
  if (!fs.existsSync(absolutePath)) {
    return { missing: true }
  }

  try {
    acorn.parse(fs.readFileSync(absolutePath, 'utf-8'), { ecmaVersion: 5 })
    return {}
  } catch (error) {
    return { error }
  }
}

function formatError(error) {
  return typeof error.loc?.line === 'number' ? `line ${error.loc.line}: ${error.message}` : error.message
}
