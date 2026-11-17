import { HookNames, monitor } from '@flashcatcloud/browser-core'
import type { RumConfiguration } from '../configuration'
import type { ViewportDimension } from '../../browser/viewportObservable'
import { getViewportDimension, initViewportObservable } from '../../browser/viewportObservable'
import type { DefaultRumEventAttributes, Hooks } from '../hooks'
import { readScreen } from '../../browser/browserFacts'

export type DisplayContext = ReturnType<typeof startDisplayContext>

export function startDisplayContext(hooks: Hooks, configuration: RumConfiguration) {
  let viewport: ViewportDimension | undefined
  // FLASHCAT FORK - the device screen, a field the shared schema does not declare. Read once: unlike
  // the viewport it does not follow the window.
  const deviceScreen = readScreen()
  // Use requestAnimationFrame to delay the calculation of viewport dimensions until after SDK initialization, preventing long tasks.
  const animationFrameId = requestAnimationFrame(
    monitor(() => {
      viewport = getViewportDimension()
    })
  )

  const unsubscribeViewport = initViewportObservable(configuration).subscribe((viewportDimension) => {
    viewport = viewportDimension
  }).unsubscribe

  hooks.register(
    HookNames.Assemble,
    ({ eventType }): DefaultRumEventAttributes => ({
      type: eventType,
      display: viewport ? { viewport, screen: deviceScreen } : { screen: deviceScreen },
    })
  )

  return {
    stop: () => {
      unsubscribeViewport()
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId)
      }
    },
  }
}
