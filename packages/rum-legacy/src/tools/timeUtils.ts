export function dateNow(): number {
  // Not `Date.now()`: some sites wrongly "polyfill" it. A very old datejs release patched it to
  // return a Date instance rather than a timestamp. That kind of dependency is exactly what a page
  // still targeting these browsers is likely to be carrying, so read the time the safe way.
  return new Date().getTime()
}
