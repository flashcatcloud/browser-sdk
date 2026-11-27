const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

const { getDistTag } = require('./publish-npm.js')

void describe('publish-npm', () => {
  void it('leaves full releases on the default npm dist-tag', () => {
    assert.equal(getDistTag('0.7.0'), undefined)
    assert.equal(getDistTag('1.2.3'), undefined)
    assert.equal(getDistTag('0.7.0+build-123'), undefined)
  })

  void it('maps prerelease versions to their prerelease dist-tag', () => {
    assert.equal(getDistTag('0.5.0-beta.1'), 'beta')
    assert.equal(getDistTag('0.0.4-alpha.2'), 'alpha')
    assert.equal(getDistTag('1.0.0-rc.1'), 'rc')
    assert.equal(getDistTag('1.0.0-beta'), 'beta')
    assert.equal(getDistTag('1.0.0-0'), 'prerelease')
    assert.equal(getDistTag('1.0.0-latest.1'), 'prerelease')
  })
})
