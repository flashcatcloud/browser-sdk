import { dateNow } from '../tools/timeUtils'

// replaced at build time
declare const __BUILD_ENV__SDK_VERSION__: string

const INTAKE_PATH = '/api/v2/rum'

export interface IntakeConfiguration {
  clientToken: string
  proxy: string
  env?: string
  service?: string
  version?: string
  datacenter?: string
}

/*
 * Produces the same url the modern bundle sends to, so that one reverse proxy rule on the customer
 * domain serves both builds and the intake needs no compatibility branch.
 *
 * Two details are easy to get wrong and both would break that:
 *   - the real intake path travels inside the `ddforward` query parameter, it is not appended to
 *     the proxy path
 *   - the proxy value is resolved to an absolute url first, so a relative `/rum-intake/` reaches
 *     the intake as `https://<page host>/rum-intake/`
 */
export function createIntakeUrlBuilder(configuration: IntakeConfiguration): () => string {
  const baseUrl = normalizeUrl(configuration.proxy)
  const configurationTags = buildTags(configuration)

  return function build() {
    const parameters = buildParameters(configuration, configurationTags)
    return `${baseUrl}?ddforward=${encodeURIComponent(`${INTAKE_PATH}?${parameters}`)}`
  }
}

function buildParameters(configuration: IntakeConfiguration, configurationTags: string[]): string {
  const tags = [`sdk_version:${__BUILD_ENV__SDK_VERSION__}`, 'api:xhr'].concat(configurationTags)

  return [
    'ddsource=browser',
    `ddtags=${encodeURIComponent(tags.join(','))}`,
    `dd-api-key=${configuration.clientToken}`,
    `dd-evp-origin-version=${encodeURIComponent(__BUILD_ENV__SDK_VERSION__)}`,
    'dd-evp-origin=browser',
    `dd-request-id=${generateUUID()}`,
    // This build only ever sends to the rum track, which always carries a batch time.
    `batch_time=${dateNow()}`,
  ].join('&')
}

function buildTags(configuration: IntakeConfiguration): string[] {
  const tags: string[] = []

  // Same keys and same order as the modern bundle. The tag character validation it performs is
  // skipped: it relies on unicode property escapes, which the browsers this build targets do not
  // support, and it only ever produces a console warning.
  if (configuration.env) {
    tags.push(buildTag('env', configuration.env))
  }
  if (configuration.service) {
    tags.push(buildTag('service', configuration.service))
  }
  if (configuration.version) {
    tags.push(buildTag('version', configuration.version))
  }
  if (configuration.datacenter) {
    tags.push(buildTag('datacenter', configuration.datacenter))
  }

  return tags
}

function buildTag(key: string, rawValue: string): string {
  // Commas separate tags, so a value containing one could forge additional tags.
  return `${key}:${rawValue.replace(/,/g, '_')}`
}

/**
 * Resolves a possibly relative url against the current document.
 *
 * The modern bundle uses the URL constructor when available. Here the anchor element trick is the
 * only option: IE9 has no URL constructor, and merely referencing the `URL` global to feature-detect
 * it throws a ReferenceError there.
 */
export function normalizeUrl(url: string): string {
  const anchor = document.createElement('a')
  anchor.href = url
  return anchor.href
}

/**
 * RFC4122 version 4 uuid, lowercase. Sourced from Math.random rather than crypto: IE9 has no
 * crypto.getRandomValues. The session cookie parser rejects uppercase characters, so the lowercase
 * output of toString(16) matters.
 */
export function generateUUID(): string {
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (character) => {
    const digit = Number(character)
    // eslint-disable-next-line no-bitwise
    return (digit ^ ((Math.random() * 16) >> (digit / 4))).toString(16)
  })
}
