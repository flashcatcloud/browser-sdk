'use strict'

const fs = require('fs')
const path = require('path')
const { printLog, printError, runMain } = require('../lib/executionUtils')
const { packages, ossEnvironments } = require('./lib/deploymentUtils')

/**
 * Download the deployed bundles from the CDN into a local directory, to serve them from another
 * origin. Private deployments self-host every asset — their networks often cannot reach the public
 * CDN at all — and this is the supported way to obtain a complete, coherent set.
 *
 * Usage:
 * node sync-bundles.js [env] [version] [outputDir]
 * env = prod|staging, defaults to prod
 * version = the major-version directory, ex: v0. Defaults to v<major> from lerna.json
 * outputDir = defaults to ./cdn-bundles
 *
 * The script needs no credentials: it downloads over plain HTTPS from the same URLs a page would
 * load. The bucket cannot be listed that way, so the entry bundles are fetched by name (declared
 * next to the upload configuration in lib/deploymentUtils.js) and the hash-named chunk files are
 * recovered from the chunk table webpack embeds in each entry bundle. Downloading chunks by hand is
 * exactly the error-prone step this script exists to remove.
 */

// Matches the webpack runtime's chunk url construction, ex:
// "chunks/"+t+"-"+{recorder:"1d21...",profiler:"617a..."}[t]+"-flashcat-rum.js"
const CHUNK_TABLE_RE = /"chunks\/"\+\w+\+"-"\+(\{[^{}]*\})\[\w+\]\+"-([\w.-]+\.js)"/
// Webpack quotes a key that is not a valid identifier, so both shapes have to match. A chunk this
// misses would be silently absent from the output rather than reported, which is the one failure
// this script must not have.
const CHUNK_ENTRY_RE = /(?:"([^"]+)"|([\w$]+)):"([a-f0-9]+)"/g

if (require.main === module) {
  const env = process.argv[2] || 'prod'
  const version = process.argv[3] || `v${require('../../lerna.json').version.split('.')[0]}`
  const outputDir = process.argv[4] || './cdn-bundles'

  const ossConfig = ossEnvironments[env]
  if (!ossConfig) {
    printError(`Unknown env "${env}", expected one of: ${Object.keys(ossEnvironments).join(', ')}`)
    process.exit(1)
  }

  runMain(async () => {
    await main(ossConfig, version, outputDir)
  })
}

async function main(ossConfig, version, outputDir) {
  const baseUrl = `https://${ossConfig.cdnURL}${ossConfig.dir}/${version}`
  const failures = []

  /*
   * Downloaded into a directory named for being unfinished, and moved into place only once every
   * file is there. A run that is interrupted — Ctrl-C, a CI timeout, a killed process — never gets
   * to print its warning, so the only thing left to tell a complete set from a half-written one is
   * the name on disk. An entry bundle without its chunks looks entirely normal otherwise.
   *
   * An existing output directory is refused rather than merged into or deleted: merging would
   * leave the chunks of an older version alongside the new ones, and deleting a directory the
   * operator named is not this script's call to make.
   */
  if (fs.existsSync(outputDir)) {
    printError(`${outputDir} already exists. Remove it, or pass a different output directory.`)
    process.exit(1)
  }
  const stagingDir = `${outputDir}.incomplete`
  fs.rmSync(stagingDir, { recursive: true, force: true })

  for (const { bundleFilename } of packages) {
    const content = await download(baseUrl, bundleFilename, stagingDir, failures)
    if (content === undefined) {
      continue
    }

    for (const chunkPath of extractChunkPaths(content)) {
      await download(baseUrl, chunkPath, stagingDir, failures)
    }
  }

  if (failures.length > 0) {
    printError('Some files could not be downloaded:')
    for (const failure of failures) {
      printError(`  - ${failure}`)
    }
    printError(`Left in ${stagingDir}, which is incomplete. Do not deploy it.`)
    process.exit(1)
  }

  fs.renameSync(stagingDir, outputDir)
  printLog(`\nDone. Serve the content of ${outputDir} and load the bundles from that origin.`)
}

async function download(baseUrl, filePath, outputDir, failures) {
  const url = `${baseUrl}/${filePath}`

  let response
  try {
    response = await fetch(url)
  } catch (error) {
    // A refused connection or a DNS failure is the expected shape of trouble here: this script runs
    // for people whose network cannot reach much. Letting it throw would skip the summary below and
    // the "do not deploy" warning, leaving a stack trace as the only thing the operator sees.
    failures.push(`${url} (${error.message})`)
    return undefined
  }

  if (!response.ok) {
    failures.push(`${url} (HTTP ${response.status})`)
    return undefined
  }

  const content = Buffer.from(await response.arrayBuffer())
  const outputPath = path.join(outputDir, filePath)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, content)
  printLog(`✅ ${url} → ${outputPath} (${content.length} bytes)`)
  return content.toString('utf-8')
}

function extractChunkPaths(bundleContent) {
  const table = CHUNK_TABLE_RE.exec(bundleContent)
  if (!table) {
    return []
  }

  const [, entries, entryFilename] = table
  const chunkPaths = []
  for (const [, quotedName, bareName, hash] of entries.matchAll(CHUNK_ENTRY_RE)) {
    chunkPaths.push(`chunks/${quotedName ?? bareName}-${hash}-${entryFilename}`)
  }

  // A chunk the pattern above failed to read would go missing without ever being attempted, and so
  // without ever reaching the failure list. Counting the entries in the table is the cheap way to
  // notice that, and this is a directory someone is about to serve to their users.
  const declared = (entries.match(/:"/g) || []).length
  if (chunkPaths.length !== declared) {
    throw new Error(
      `Read ${chunkPaths.length} of ${declared} chunk names from ${entryFilename}; the pattern needs updating`
    )
  }

  return chunkPaths
}
