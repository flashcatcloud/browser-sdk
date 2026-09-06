import { createEndpointBuilder } from '../../../core/src/domain/configuration'
import type { BuildEnvWindow } from '../../../core/test'
import { createIntakeUrlBuilder } from './intakeUrl'

/**
 * The whole "no backend change" property of this build rests on one thing: the URL this package
 * produces has to be shaped exactly like the modern bundle's, so that a single reverse proxy rule
 * serves both. Rather than hard-coding what we believe that shape to be, these specs build the
 * reference URL with the modern implementation and compare against it. If the modern builder ever
 * changes, this fails instead of silently drifting.
 */
describe('intake url', () => {
  const CLIENT_TOKEN = 'some_client_token'
  const PROXY = '/rum-intake/'

  beforeEach(() => {
    ;(window as unknown as BuildEnvWindow).__BUILD_ENV__SDK_VERSION__ = 'test-version'
  })

  function buildModernUrl(initConfiguration: { clientToken: string; proxy: string }, tags: string[] = []) {
    return createEndpointBuilder(initConfiguration, 'rum', tags).build('fetch', {
      data: '',
      bytesCount: 0,
    })
  }

  function parse(url: string) {
    const [base, query] = url.split('?ddforward=')
    const forwarded = decodeURIComponent(query)
    const [path, parameters] = forwarded.split('?')
    const entries = parameters.split('&').map((entry) => {
      const separatorIndex = entry.indexOf('=')
      return [entry.slice(0, separatorIndex), entry.slice(separatorIndex + 1)] as const
    })
    return {
      base,
      path,
      keys: entries.map(([key]) => key),
      values: new Map(entries),
    }
  }

  it('resolves the proxy path to an absolute url, like the modern bundle does', () => {
    const legacy = parse(createIntakeUrlBuilder({ clientToken: CLIENT_TOKEN, proxy: PROXY })())
    const modern = parse(buildModernUrl({ clientToken: CLIENT_TOKEN, proxy: PROXY }))

    expect(legacy.base).toBe(modern.base)
    expect(legacy.base).toBe(`${location.origin}${PROXY}`)
  })

  it('forwards the same intake path', () => {
    const legacy = parse(createIntakeUrlBuilder({ clientToken: CLIENT_TOKEN, proxy: PROXY })())
    const modern = parse(buildModernUrl({ clientToken: CLIENT_TOKEN, proxy: PROXY }))

    expect(legacy.path).toBe(modern.path)
    expect(legacy.path).toBe('/api/v2/rum')
  })

  it('emits the same query parameters in the same order', () => {
    const legacy = parse(createIntakeUrlBuilder({ clientToken: CLIENT_TOKEN, proxy: PROXY })())
    const modern = parse(buildModernUrl({ clientToken: CLIENT_TOKEN, proxy: PROXY }))

    expect(legacy.keys).toEqual(modern.keys)
  })

  it('emits the same values for every parameter that is not per-request', () => {
    const legacy = parse(createIntakeUrlBuilder({ clientToken: CLIENT_TOKEN, proxy: PROXY })())
    const modern = parse(buildModernUrl({ clientToken: CLIENT_TOKEN, proxy: PROXY }))

    for (const key of ['ddsource', 'dd-api-key', 'dd-evp-origin', 'dd-evp-origin-version']) {
      expect(legacy.values.get(key)).toBe(modern.values.get(key), `parameter ${key} differs`)
    }
  })

  it('reports the transport actually used in the api tag', () => {
    const legacy = parse(createIntakeUrlBuilder({ clientToken: CLIENT_TOKEN, proxy: PROXY })())

    const tags = decodeURIComponent(legacy.values.get('ddtags')!).split(',')
    expect(tags).toContain('api:xhr')
    expect(tags).toContain('sdk_version:test-version')
  })

  it('builds the configuration tags like the modern bundle', () => {
    const configuration = {
      clientToken: CLIENT_TOKEN,
      proxy: PROXY,
      env: 'staging',
      service: 'checkout',
      version: '1.2.3',
    }
    const legacy = parse(createIntakeUrlBuilder(configuration)())
    const modern = parse(buildModernUrl(configuration, ['env:staging', 'service:checkout', 'version:1.2.3']))

    const withoutApi = (tags: string) =>
      decodeURIComponent(tags)
        .split(',')
        .filter((tag) => tag.indexOf('api:') !== 0)

    expect(withoutApi(legacy.values.get('ddtags')!)).toEqual(withoutApi(modern.values.get('ddtags')!))
  })

  it('replaces commas in tag values so a value cannot forge extra tags', () => {
    const legacy = parse(createIntakeUrlBuilder({ clientToken: CLIENT_TOKEN, proxy: PROXY, service: 'a,b' })())

    expect(decodeURIComponent(legacy.values.get('ddtags')!).split(',')).toContain('service:a_b')
  })

  it('sends a fresh request id and batch time on every build', () => {
    const build = createIntakeUrlBuilder({ clientToken: CLIENT_TOKEN, proxy: PROXY })
    const first = parse(build())
    const second = parse(build())

    expect(first.values.get('dd-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.values.get('dd-request-id')).not.toBe(second.values.get('dd-request-id'))
    expect(Number(first.values.get('batch_time'))).toBeGreaterThan(0)
  })

  it('supports an absolute proxy url', () => {
    const proxy = 'https://collector.example.com/rum-intake/'
    const legacy = parse(createIntakeUrlBuilder({ clientToken: CLIENT_TOKEN, proxy })())
    const modern = parse(buildModernUrl({ clientToken: CLIENT_TOKEN, proxy }))

    expect(legacy.base).toBe(modern.base)
  })
})
