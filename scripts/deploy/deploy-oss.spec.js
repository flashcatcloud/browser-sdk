const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

process.env.OSS_REGION = 'oss-region'
process.env.OSS_ACCESS_KEY = 'oss-access-key'
process.env.OSS_SECRET_KEY = 'oss-secret-key'
process.env.OSS_BUCKET = 'oss-bucket'

const { isPrereleaseVersion, isHighestRelease } = require('./deploy-oss.js')

void describe('deploy-oss', () => {
  void it('detects prerelease versions', () => {
    assert.equal(isPrereleaseVersion('v0.0.4-alpha.2'), true)
    assert.equal(isPrereleaseVersion('v1.2.3-beta.1'), true)
    assert.equal(isPrereleaseVersion('v1.2.3-rc.1'), true)
    assert.equal(isPrereleaseVersion('v1.2.3'), false)
    assert.equal(isPrereleaseVersion('v0'), false)
  })

  void it('updates latest only for the highest full release', () => {
    const published = ['v0', 'v0.4.0', 'v0.5.0', 'v0.10.0', 'v0.11.0-beta.1', 'latest']
    assert.equal(isHighestRelease('v0.10.0', published), true)
    assert.equal(isHighestRelease('v0.10.1', [...published, 'v0.10.1']), true)
    assert.equal(isHighestRelease('v0.5.0', published), false)
    assert.equal(isHighestRelease('v0.9.1', [...published, 'v0.9.1']), false)
    assert.equal(isHighestRelease('v1.0.0', [...published, 'v1.0.0']), true)
    assert.equal(isHighestRelease('v1.0.0-beta.1', [...published, 'v1.0.0-beta.1']), false)
    assert.equal(isHighestRelease('v1.0.0-beta.1', ['v1.0.0-beta.1']), false)
  })
})
