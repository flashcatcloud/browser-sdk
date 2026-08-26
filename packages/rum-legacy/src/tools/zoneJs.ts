interface WindowWithZoneJs extends Window {
  Zone?: {
    // Every Zone.js version exposes __symbol__, but some pages define an unrelated global named
    // 'Zone', so treat it as optional.
    __symbol__?: (name: string) => string
  }
}

/**
 * Returns the unpatched value of a DOM API that Zone.js may have replaced.
 *
 * Zone.js patches timers and event registration, keeping the originals on hidden
 * `__zone_symbol__`-prefixed properties. Its patched versions have been observed to cause memory
 * leaks and high CPU usage in host pages. Since the first requirement of this build is that the
 * page keeps working normally, the timer and listener calls go through here.
 */
export function getZoneJsOriginalValue<Target, Name extends keyof Target & string>(
  target: Target,
  name: Name
): Target[Name] {
  const browserWindow = window as WindowWithZoneJs
  let original: Target[Name] | undefined

  if (browserWindow.Zone && typeof browserWindow.Zone.__symbol__ === 'function') {
    original = (target as any)[browserWindow.Zone.__symbol__(name)]
  }

  if (!original) {
    original = target[name]
  }

  return original
}
