import type { Configuration } from '../domain/configuration'
import { ONE_SECOND } from '../tools/utils/timeUtils'
import type { Clock } from '../../test'
import { createNewEvent, setPageVisibility, restorePageVisibility, registerCleanupTask, mockClock } from '../../test'
import { createPageActivationObservable } from './pageActivationObservable'

describe('createPageActivationObservable', () => {
  let onActivateSpy: jasmine.Spy<() => void>
  let configuration: Configuration
  let clock: Clock

  beforeEach(() => {
    onActivateSpy = jasmine.createSpy()
    configuration = {} as Configuration
    clock = mockClock()
    registerCleanupTask(createPageActivationObservable(configuration).subscribe(onActivateSpy).unsubscribe)
    registerCleanupTask(() => {
      restorePageVisibility()
      clock.cleanup()
    })
  })

  it('notifies on focus after a blur', () => {
    window.dispatchEvent(createNewEvent('blur'))
    window.dispatchEvent(createNewEvent('focus'))

    expect(onActivateSpy).toHaveBeenCalledTimes(1)
  })

  it('does NOT notify on focus without a prior blur or hide', () => {
    window.dispatchEvent(createNewEvent('focus'))

    expect(onActivateSpy).not.toHaveBeenCalled()
  })

  it('notifies on visibilitychange visible after becoming hidden', () => {
    emulatePageVisibilityChange('hidden')
    emulatePageVisibilityChange('visible')

    expect(onActivateSpy).toHaveBeenCalledTimes(1)
  })

  it('notifies on pageshow after being inactive', () => {
    window.dispatchEvent(createNewEvent('blur'))
    window.dispatchEvent(createNewEvent('pageshow'))

    expect(onActivateSpy).toHaveBeenCalledTimes(1)
  })

  it('debounces two reactivations within the debounce window to one', () => {
    window.dispatchEvent(createNewEvent('blur'))
    window.dispatchEvent(createNewEvent('focus'))
    window.dispatchEvent(createNewEvent('blur'))
    window.dispatchEvent(createNewEvent('focus'))

    expect(onActivateSpy).toHaveBeenCalledTimes(1)
  })

  it('notifies twice for two genuine cycles spaced beyond the debounce window', () => {
    window.dispatchEvent(createNewEvent('blur'))
    window.dispatchEvent(createNewEvent('focus'))
    clock.tick(ONE_SECOND + 1)
    window.dispatchEvent(createNewEvent('blur'))
    window.dispatchEvent(createNewEvent('focus'))

    expect(onActivateSpy).toHaveBeenCalledTimes(2)
  })

  function emulatePageVisibilityChange(visibility: 'visible' | 'hidden') {
    setPageVisibility(visibility)
    document.dispatchEvent(createNewEvent('visibilitychange'))
  }
})
