import { setNavigatorUserAgentData } from '@flashcatcloud/browser-core/test'
import { readScreen, readUABrands } from './browserFacts'

describe('browserFacts', () => {
  describe('readUABrands', () => {
    it('writes the brands like the Sec-CH-UA header', () => {
      setNavigatorUserAgentData({
        brands: [
          { brand: 'Not-A.Brand', version: '99' },
          { brand: 'Google Chrome', version: '157' },
        ],
      })

      expect(readUABrands()).toBe('"Not-A.Brand";v="99", "Google Chrome";v="157"')
    })

    it('escapes quotes and backslashes like a structured-field string', () => {
      setNavigatorUserAgentData({ brands: [{ brand: 'Not"A\\Brand', version: '8' }] })

      expect(readUABrands()).toBe('"Not\\"A\\\\Brand";v="8"')
    })

    it('is undefined without userAgentData', () => {
      setNavigatorUserAgentData(undefined)

      expect(readUABrands()).toBeUndefined()
    })
  })

  describe('readScreen', () => {
    it('reads the device screen', () => {
      expect(readScreen()).toEqual({ width: window.screen.width, height: window.screen.height })
    })
  })
})
