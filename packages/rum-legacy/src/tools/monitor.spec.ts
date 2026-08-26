import { monitor } from './monitor'

describe('monitor', () => {
  it('passes arguments and the return value through when nothing fails', () => {
    const wrapped = monitor((a: number, b: number) => a + b)

    expect(wrapped(2, 3)).toBe(5)
  })

  it('swallows a failure instead of letting it reach the caller', () => {
    const wrapped = monitor(() => {
      throw new Error('internal failure')
    })

    expect(() => wrapped()).not.toThrow()
  })

  it('returns undefined when the wrapped function failed', () => {
    const wrapped = monitor(() => {
      throw new Error('internal failure')
    })

    expect(wrapped()).toBeUndefined()
  })
})
