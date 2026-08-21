import ajv from 'ajv'
// Test-only import of the schema bundle the modern packages validate against. The event shape is
// defined by the intake, not by this package, so it is validated against the real thing rather
// than against a hand-written expectation. Reaching past the test index is deliberate: this bundle
// is generated with require.context and is not re-exported there.
// eslint-disable-next-line local-rules/disallow-protected-directory-import
import { allJsonSchemas } from '../../../rum-core/test/allJsonSchemas'
import { assembleEvent } from './eventAssembly'

function expectValidRumEvent(event: object) {
  const instance = new ajv({ allErrors: true })
  instance.addSchema(allJsonSchemas as any)
  void instance.validate('rum-events-schema.json', event)

  if (instance.errors) {
    const errors = instance.errors.map((error) => `  event${error.instancePath || ''} ${error.message}`).join('\n')
    fail(`Invalid RUM event format:\n${errors}`)
  }
}

describe('event assembly', () => {
  const CONFIGURATION = {
    applicationId: '00000000-aaaa-0000-aaaa-000000000000',
    sessionSampleRate: 100,
  }
  const SESSION_ID = '11111111-aaaa-0000-aaaa-000000000000'
  const VIEW = {
    id: '22222222-aaaa-0000-aaaa-000000000000',
    url: 'https://example.com/checkout',
    referrer: 'https://example.com/',
    startTime: 1600000000000,
  }

  function assemble(type: string, properties: object, context?: object) {
    return assembleEvent({
      type,
      configuration: CONFIGURATION,
      sessionId: SESSION_ID,
      view: VIEW,
      properties,
      context,
    })
  }

  it('produces an error event the intake schema accepts', () => {
    expectValidRumEvent(
      assemble('error', {
        error: {
          id: '33333333-aaaa-0000-aaaa-000000000000',
          message: 'boom',
          source: 'source',
          handling: 'unhandled',
          source_type: 'browser',
        },
      })
    )
  })

  it('produces a view event the intake schema accepts', () => {
    expectValidRumEvent(
      assemble('view', {
        view: {
          loading_type: 'initial_load',
          time_spent: 1_000_000,
          is_active: true,
          action: { count: 0 },
          error: { count: 0 },
          resource: { count: 0 },
          long_task: { count: 0 },
          frustration: { count: 0 },
        },
        _dd: { document_version: 1 },
      })
    )
  })

  it('produces an action event the intake schema accepts', () => {
    expectValidRumEvent(
      assemble('action', {
        action: {
          id: '44444444-aaaa-0000-aaaa-000000000000',
          type: 'custom',
          target: { name: 'checkout' },
        },
      })
    )
  })

  it('carries the identity fields every event needs', () => {
    const event = assemble('error', { error: { message: 'boom', source: 'source' } }) as any

    expect(event.type).toBe('error')
    expect(event.source).toBe('browser')
    expect(event.application.id).toBe(CONFIGURATION.applicationId)
    expect(event.session).toEqual({ id: SESSION_ID, type: 'user' })
    // The view's start time dates the event; it is not one of the view's own fields on the wire.
    expect(event.view).toEqual({ id: VIEW.id, url: VIEW.url, referrer: VIEW.referrer })
    expect(event.date).toBeGreaterThan(0)
    expect(event._dd.format_version).toBe(2)
  })

  it('reports the sample rates it was configured with', () => {
    const event = assemble('error', { error: { message: 'boom', source: 'source' } }) as any

    expect(event._dd.configuration.session_sample_rate).toBe(100)
    // Session replay cannot run on these browsers, so the rate is reported as zero rather than
    // left out, which would read as "unknown" downstream.
    expect(event._dd.configuration.session_replay_sample_rate).toBe(0)
  })

  it('leaves out service and version when they are not configured', () => {
    const event = assemble('error', { error: { message: 'boom', source: 'source' } }) as any

    expect('service' in event).toBe(false)
    expect('version' in event).toBe(false)
  })

  it('includes service and version when they are configured', () => {
    const event = assembleEvent({
      type: 'error',
      configuration: { ...CONFIGURATION, service: 'checkout', version: '1.2.3' },
      sessionId: SESSION_ID,
      view: VIEW,
      properties: { error: { message: 'boom', source: 'source' } },
    }) as any

    expect(event.service).toBe('checkout')
    expect(event.version).toBe('1.2.3')
  })

  it('attaches user context but never lets it overwrite identity fields', () => {
    const event = assemble('error', { error: { message: 'boom', source: 'source' } }, { orderId: 42, type: 'spoofed' })

    expect((event as any).context).toEqual({ orderId: 42, type: 'spoofed' })
    expect((event as any).type).toBe('error')
  })

  it('leaves out an empty context', () => {
    const event = assemble('error', { error: { message: 'boom', source: 'source' } }, {})

    expect('context' in event).toBe(false)
  })

  it('merges the event specific properties into the envelope', () => {
    const event = assemble('view', {
      view: { time_spent: 5, action: { count: 1 }, error: { count: 0 }, resource: { count: 0 } },
    }) as any

    // The view sub-object has to keep the identity fields as well as the event specific ones.
    expect(event.view.id).toBe(VIEW.id)
    expect(event.view.url).toBe(VIEW.url)
    expect(event.view.time_spent).toBe(5)
  })
})
