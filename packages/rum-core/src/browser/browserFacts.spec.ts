import { readScreen, readUABrands } from './browserFacts'

describe('browserFacts', () => {
  describe('readUABrands', () => {
    it('writes the brands like the Sec-CH-UA header', () => {
      spyOnProperty(navigator as any, 'userAgentData', 'get').and.returnValue({
        brands: [
          { brand: 'Not-A.Brand', version: '99' },
          { brand: 'Google Chrome', version: '157' },
        ],
      })

      expect(readUABrands()).toBe('"Not-A.Brand";v="99", "Google Chrome";v="157"')
    })

    it('escapes quotes and backslashes like a structured-field string', () => {
      spyOnProperty(navigator as any, 'userAgentData', 'get').and.returnValue({
        brands: [{ brand: 'Not"A\\Brand', version: '8' }],
      })

      expect(readUABrands()).toBe('"Not\\"A\\\\Brand";v="8"')
    })

    it('is undefined without userAgentData', () => {
      spyOnProperty(navigator as any, 'userAgentData', 'get').and.returnValue(undefined)

      expect(readUABrands()).toBeUndefined()
    })
  })

  describe('readScreen', () => {
    it('reads the device screen', () => {
      expect(readScreen()).toEqual({ width: window.screen.width, height: window.screen.height })
    })
  })
})
