import type { ContextManager, RelativeTime } from '@flashcatcloud/browser-core'
import { HookNames, removeStorageListeners } from '@flashcatcloud/browser-core'
import { mockEventBridge, registerCleanupTask } from '@flashcatcloud/browser-core/test'
import { createRumSessionManagerMock, mockRumConfiguration } from '../../../test'
import type { Hooks } from '../hooks'
import { createHooks } from '../hooks'
import { startUserContext } from './userContext'

describe('user context', () => {
  let userContext: ContextManager
  let hooks: Hooks

  beforeEach(() => {
    hooks = createHooks()
    userContext = startUserContext(
      hooks,
      mockRumConfiguration({ trackAnonymousUser: false }),
      createRumSessionManagerMock()
    )
  })

  it('should sanitize predefined properties', () => {
    userContext.setContext({ id: false, name: 2, email: { bar: 'qux' } })

    expect(userContext.getContext()).toEqual({
      email: '[object Object]',
      id: 'false',
      name: '2',
    })
  })

  describe('assemble hook', () => {
    it('should set the user', () => {
      userContext.setContext({ id: '123', foo: 'bar' })
      const defaultRumEventAttributes = hooks.triggerHook(HookNames.Assemble, {
        eventType: 'view',
        startTime: 0 as RelativeTime,
      })

      expect(defaultRumEventAttributes).toEqual({
        type: 'view',
        usr: {
          id: '123',
          foo: 'bar',
        },
      })
    })

    it('should set anonymous_id when trackAnonymousUser is true', () => {
      userContext = startUserContext(
        hooks,
        mockRumConfiguration({ trackAnonymousUser: true }),
        createRumSessionManagerMock()
      )
      userContext.setContext({ id: '123' })
      const defaultRumEventAttributes = hooks.triggerHook(HookNames.Assemble, {
        eventType: 'view',
        startTime: 0 as RelativeTime,
      })

      expect(defaultRumEventAttributes).toEqual({
        type: 'view',
        usr: {
          id: '123',
          anonymous_id: 'device-123',
        },
      })
    })

    // FLASHCAT FORK - pins the web behavior the bridge case below deviates from.
    it('should backfill the user id with the anonymous id when no user is set', () => {
      userContext = startUserContext(
        hooks,
        mockRumConfiguration({ trackAnonymousUser: true }),
        createRumSessionManagerMock()
      )
      const defaultRumEventAttributes = hooks.triggerHook(HookNames.Assemble, {
        eventType: 'view',
        startTime: 0 as RelativeTime,
      })

      expect(defaultRumEventAttributes).toEqual({
        type: 'view',
        usr: {
          id: 'device-123',
          anonymous_id: 'device-123',
        },
      })
    })

    // FLASHCAT FORK - see `getAnonymousId` in `DatadogEventBridge`.
    describe('when a host application provides the anonymous id', () => {
      it('should not backfill the user id, but still set anonymous_id', () => {
        mockEventBridge()
        userContext = startUserContext(
          hooks,
          mockRumConfiguration({ trackAnonymousUser: true }),
          createRumSessionManagerMock()
        )
        const defaultRumEventAttributes = hooks.triggerHook(HookNames.Assemble, {
          eventType: 'view',
          startTime: 0 as RelativeTime,
        })

        expect(defaultRumEventAttributes).toEqual({
          type: 'view',
          usr: {
            anonymous_id: 'device-123',
          },
        })
      })

      it('should leave a customer provided user id untouched', () => {
        mockEventBridge()
        userContext = startUserContext(
          hooks,
          mockRumConfiguration({ trackAnonymousUser: true }),
          createRumSessionManagerMock()
        )
        userContext.setContext({ id: '123' })
        const defaultRumEventAttributes = hooks.triggerHook(HookNames.Assemble, {
          eventType: 'view',
          startTime: 0 as RelativeTime,
        })

        expect(defaultRumEventAttributes).toEqual({
          type: 'view',
          usr: {
            id: '123',
            anonymous_id: 'device-123',
          },
        })
      })
    })

    it('should not override customer provided anonymous_id when trackAnonymousUser is true', () => {
      userContext = startUserContext(
        hooks,
        mockRumConfiguration({ trackAnonymousUser: true }),
        createRumSessionManagerMock()
      )
      userContext.setContext({ id: '123', anonymous_id: 'foo' })
      const defaultRumEventAttributes = hooks.triggerHook(HookNames.Assemble, {
        eventType: 'view',
        startTime: 0 as RelativeTime,
      })

      expect(defaultRumEventAttributes).toEqual({
        type: 'view',
        usr: {
          id: '123',
          anonymous_id: 'foo',
        },
      })
    })
  })
})

describe('user context across pages', () => {
  let userContext: ContextManager
  let hooks: Hooks

  beforeEach(() => {
    hooks = createHooks()

    registerCleanupTask(() => {
      localStorage.clear()
      removeStorageListeners()
    })
  })

  it('when disabled, should store contexts only in memory', () => {
    userContext = startUserContext(
      hooks,
      mockRumConfiguration({ storeContextsAcrossPages: false }),
      createRumSessionManagerMock()
    )
    userContext.setContext({ id: '123' })

    expect(userContext.getContext()).toEqual({ id: '123' })
    expect(localStorage.getItem('_dd_c_rum_1')).toBeNull()
  })

  it('when enabled, should maintain the user in local storage', () => {
    userContext = startUserContext(
      hooks,
      mockRumConfiguration({ storeContextsAcrossPages: true }),
      createRumSessionManagerMock()
    )

    userContext.setContext({ id: 'foo', qux: 'qix' })
    expect(userContext.getContext()).toEqual({ id: 'foo', qux: 'qix' })
    expect(localStorage.getItem('_dd_c_rum_1')).toBe('{"id":"foo","qux":"qix"}')
  })
})
