const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

process.env.OSS_REGION = 'oss-region'
process.env.OSS_ACCESS_KEY = 'oss-access-key'
process.env.OSS_SECRET_KEY = 'oss-secret-key'
process.env.OSS_BUCKET = 'oss-bucket'

const { isPrereleaseVersion } = require('./deploy-oss.js')

void describe('deploy-oss', () => {
  void it('detects prerelease versions', () => {
    assert.equal(isPrereleaseVersion('v0.0.4-alpha.2'), true)
    assert.equal(isPrereleaseVersion('v1.2.3-beta.1'), true)
    assert.equal(isPrereleaseVersion('v1.2.3-rc.1'), true)
    assert.equal(isPrereleaseVersion('v1.2.3'), false)
    assert.equal(isPrereleaseVersion('v0'), false)
  })
})
