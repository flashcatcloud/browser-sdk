import type { QueuedGlobal } from './global'
import { defineGlobal } from './global'

describe('defineGlobal', () => {
  let host: { FC_RUM?: QueuedGlobal }
  const api = { version: 'test' }

  beforeEach(() => {
    host = {}
  })

  it('exposes the api on the host object', () => {
    defineGlobal(host, 'FC_RUM', api)

    expect(host.FC_RUM).toBe(api)
  })

  it('runs callbacks queued by the loader snippet before the bundle arrived', () => {
    const calls: string[] = []
    host.FC_RUM = { q: [() => calls.push('first'), () => calls.push('second')] }

    defineGlobal(host, 'FC_RUM', api)

    expect(calls).toEqual(['first', 'second'])
  })

  it('runs queued callbacks against the real api, not the placeholder', () => {
    let seen: unknown
    host.FC_RUM = { q: [() => (seen = host.FC_RUM)] }

    defineGlobal(host, 'FC_RUM', api)

    expect(seen).toBe(api)
  })

  it('keeps running the remaining callbacks when one of them throws', () => {
    const calls: string[] = []
    host.FC_RUM = {
      q: [
        () => {
          throw new Error('customer callback is broken')
        },
        () => calls.push('second'),
      ],
    }

    expect(() => defineGlobal(host, 'FC_RUM', api)).not.toThrow()
    expect(calls).toEqual(['second'])
  })

  it('does not fail when no placeholder was set up', () => {
    expect(() => defineGlobal(host, 'FC_RUM', api)).not.toThrow()
    expect(host.FC_RUM).toBe(api)
  })

  it('does not fail when the placeholder has no queue', () => {
    host.FC_RUM = { version: 'already-loaded' }

    expect(() => defineGlobal(host, 'FC_RUM', api)).not.toThrow()
    expect(host.FC_RUM).toBe(api)
  })
})
