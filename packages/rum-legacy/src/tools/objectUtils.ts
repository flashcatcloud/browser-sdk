/*
 * Object.assign and the spread operator both need ES2015, and `lib: ES5` rejects them outright, so
 * these two shapes are needed in more than one place and live here rather than being repeated.
 */

export function shallowMerge(base: { [key: string]: any }, extra: { [key: string]: any }): { [key: string]: any } {
  const result: { [key: string]: any } = {}
  for (const key in base) {
    if (Object.prototype.hasOwnProperty.call(base, key)) {
      result[key] = base[key]
    }
  }
  for (const key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      result[key] = extra[key]
    }
  }
  return result
}

export function isEmptyObject(value: { [key: string]: any }): boolean {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return false
    }
  }
  return true
}
