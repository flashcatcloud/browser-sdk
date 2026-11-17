/**
 * Facts about the visitor's browser that the user agent string does not carry, sent on events and on
 * the active-device report so the backend can tell automated traffic apart. Fork additions.
 */

interface NavigatorUABrand {
  brand: string
  version: string
}

/**
 * `navigator.userAgentData.brands` in the format of the `Sec-CH-UA` request header the same browser
 * sends (`"Chromium";v="157", "Google Chrome";v="157"`). The backend stores both: a page script can
 * override this one and a proxy or extension the header, so they only differ in a browser tampered
 * with on one side. Undefined where there is no userAgentData (Firefox, Safari, insecure pages).
 */
export function readUABrands(): string | undefined {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: NavigatorUABrand[] } }).userAgentData?.brands
  if (!Array.isArray(brands) || brands.length === 0) {
    return undefined
  }
  return brands.map(({ brand, version }) => `${quote(brand)};v=${quote(version)}`).join(', ')
}

/** The device screen in CSS pixels (`screen.width`, `screen.height`). */
export function readScreen(): { width: number; height: number } {
  return { width: window.screen.width, height: window.screen.height }
}

// A structured-field string, as Sec-CH-UA writes it: quoted, with backslash and quote escaped.
function quote(value: unknown) {
  return `"${String(value).replace(/[\\"]/g, '\\$&')}"`
}
