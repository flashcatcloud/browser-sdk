const OSS = require('ali-oss')
const CDN = require('@alicloud/cdn20180510')
const OpenApi = require('@alicloud/openapi-client')
const { printLog, printError, runMain } = require('../lib/executionUtils')
const { forEachFile } = require('../lib/filesUtils')

const { buildBundleFolder, packages } = require('./lib/deploymentUtils')

const AWS_CONFIG = {
  prod: {
    dir: '/browser-sdk',
    endpoint: 'flashduty-public.oss-cn-beijing.aliyuncs.com',
    cdnURL: 'static.flashcat.cloud',
  },
  staging: {
    dir: '/browser-sdk-staging',
    endpoint: 'flashduty-public.oss-cn-beijing.aliyuncs.com',
    cdnURL: 'static.flashcat.cloud',
  },
}

const client = new OSS({
  region: process.env.OSS_REGION,
  accessKeyId: process.env.OSS_ACCESS_KEY,
  accessKeySecret: process.env.OSS_SECRET_KEY,
  bucket: process.env.OSS_BUCKET,
})

/**
 * Deploy SDK files to ali OSS
 * Usage:
 * node deploy-oss.js ${env} ${version}
 * env = prod|staging
 * version = vXXX
 */

if (require.main === module) {
  const env = process.argv[2]
  const version = process.argv[3]
  if (env === 'prod' && isPrereleaseVersion(version)) {
    printError('❌❌❌❌检测到非正式版本，跳过CDN发布，当前版本为：', version)
    process.exit(1)
  }
  runMain(async () => {
    await main(env, version)
  })
}

// A release is uploaded under its own version, which is never rewritten. The highest release is also
// uploaded under `latest`, for pages that want to follow releases without changing their url.
const LATEST = 'latest'
// `latest` changes under the same url, so browsers may only keep it briefly; the CDN copy is
// refreshed explicitly after each upload.
const LATEST_CACHE_CONTROL = 'max-age=300'

async function main(env, version) {
  const awsConfig = AWS_CONFIG[env]

  await uploadPackages(awsConfig, version)

  // Redeploying an older release, or releasing a patch on an older line, must not move `latest` back.
  // The versions already published on OSS are the record of what was released, the current one included.
  const publishedVersions = await listPublishedVersions(awsConfig)
  if (!isHighestRelease(version, publishedVersions)) {
    printLog(`${version} 不是最高的正式版本，不更新 ${LATEST}`)
    return
  }
  await uploadPackages(awsConfig, LATEST, { headers: { 'Cache-Control': LATEST_CACHE_CONTROL } })
  // Versioned paths are new on every release, so only `latest` can be stale on the CDN.
  await refreshCdnDirectory(`https://${awsConfig.cdnURL}${generateUploadPath(awsConfig, '', LATEST)}`)
}

async function uploadPackages(awsConfig, version, options) {
  for (const { packageName } of packages) {
    const bundleFolder = buildBundleFolder(packageName)
    await forEachFile(bundleFolder, async (bundlePath) => {
      if (!bundlePath.endsWith('.js')) {
        return
      }
      const uploadPath = generateUploadPath(awsConfig, bundlePath.replace(`${bundleFolder}/`, ''), version)
      await client.put(uploadPath, bundlePath, options)
      printLog(`成功将 ${bundlePath} 上传到 ${uploadPath}`)
    })
  }
}

// ex: /browser-sdk/v0.5.0/flashcat-rum.js, /browser-sdk/latest/flashcat-rum.js
function generateUploadPath(awsConfig, relativeBundlePath, version) {
  return `${awsConfig.dir}/${version}/${relativeBundlePath}`
}

async function listPublishedVersions(awsConfig) {
  const prefix = `${awsConfig.dir.replace(/^\/+/, '')}/`
  const versions = []
  let marker
  do {
    const result = await client.list({ prefix, delimiter: '/', marker, 'max-keys': 1000 }, {})
    for (const directory of result.prefixes || []) {
      versions.push(directory.slice(prefix.length, -1))
    }
    marker = result.nextMarker
  } while (marker)
  return versions
}

function isHighestRelease(version, publishedVersions) {
  const current = parseRelease(version)
  return publishedVersions
    .map(parseRelease)
    .filter(Boolean)
    .every((other) => compareReleases(current, other) >= 0)
}

// Only full releases (vX.Y.Z) count: prereleases, `latest` and the retired `v0` directory are ignored.
function parseRelease(version) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return match ? match.slice(1).map(Number) : undefined
}

function compareReleases(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

async function refreshCdnDirectory(directoryUrl) {
  const config = new OpenApi.Config({
    accessKeyId: process.env.OSS_ACCESS_KEY,
    accessKeySecret: process.env.OSS_SECRET_KEY,
    endpoint: process.env.OSS_ENDPOINT,
    regionId: process.env.OSS_REGION,
  })
  const cacheClient = new CDN.default(config)
  const refreshRequest = new CDN.RefreshObjectCachesRequest({})
  refreshRequest.objectPath = directoryUrl
  refreshRequest.objectType = 'Directory'
  // Not caught: a stale `latest` would keep serving the previous release, so the deployment must fail.
  await cacheClient.refreshObjectCaches(refreshRequest)
  // The CDN applies a refresh a few minutes after accepting it.
  printLog(`已提交cdn缓存刷新：${directoryUrl}`)
}

function isPrereleaseVersion(version) {
  return version.includes('-')
}

module.exports = {
  main,
  isPrereleaseVersion,
  isHighestRelease,
}
