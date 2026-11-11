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

// A release is uploaded twice: under its own version, which is never rewritten, and under `latest`,
// which every release overwrites for pages that want to follow releases without changing their url.
const LATEST = 'latest'
// `latest` changes under the same url, so browsers may only keep it briefly; the CDN copy is
// refreshed explicitly after each upload.
const LATEST_CACHE_CONTROL = 'max-age=300'

async function main(env, version) {
  const awsConfig = AWS_CONFIG[env]

  for (const { packageName } of packages) {
    await uploadPackage(awsConfig, packageName, version)
  }
  // Versioned paths are new on every release, so only `latest` can be stale on the CDN.
  await refreshCdnDirectory(`https://${awsConfig.cdnURL}${generateUploadPath(awsConfig, '', LATEST)}`)
}

async function uploadPackage(awsConfig, packageName, version) {
  const bundleFolder = buildBundleFolder(packageName)

  await forEachFile(bundleFolder, async (bundlePath) => {
    if (!bundlePath.endsWith('.js')) {
      return
    }

    const relativeBundlePath = bundlePath.replace(`${bundleFolder}/`, '')
    const versionPath = generateUploadPath(awsConfig, relativeBundlePath, version)
    await client.put(versionPath, bundlePath)
    printLog(`成功将 ${bundlePath} 上传到 ${versionPath}`)

    const latestPath = generateUploadPath(awsConfig, relativeBundlePath, LATEST)
    await client.put(latestPath, bundlePath, { headers: { 'Cache-Control': LATEST_CACHE_CONTROL } })
    printLog(`成功将 ${bundlePath} 上传到 ${latestPath}`)
  })
}

// ex: /browser-sdk/v0.5.0/flashcat-rum.js, /browser-sdk/latest/flashcat-rum.js
function generateUploadPath(awsConfig, relativeBundlePath, version) {
  return `${awsConfig.dir}/${version}/${relativeBundlePath}`
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
  printLog(`刷新cdn缓存成功：${directoryUrl}`)
}

function isPrereleaseVersion(version) {
  return version.includes('-')
}

module.exports = {
  main,
  isPrereleaseVersion,
  generateUploadPath,
  AWS_CONFIG,
}
