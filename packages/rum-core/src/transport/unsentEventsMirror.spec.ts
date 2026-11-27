import { registerCleanupTask } from '@flashcatcloud/browser-core/test'
import type { Payload } from '@flashcatcloud/browser-core'
import type { RumConfiguration } from '../domain/configuration'
import type { UnsentRecord } from './unsentEventsMirror'
import {
  MIRROR_MAX_BYTES,
  ORPHAN_DELAY,
  RECOVERED_MAX_AGE,
  UNSENT_EVENTS_DB,
  UNSENT_EVENTS_STORE,
  keepNewest,
  startUnsentEventsMirror,
} from './unsentEventsMirror'

describe('startUnsentEventsMirror', () => {
  let fetchSpy: jasmine.Spy
  const configuration = {
    applicationId: 'app',
    rumEndpointBuilder: {
      build: (_api: string, payload: Payload) => `https://intake.test/api/v2/rum?recovered=${!!payload.recovered}`,
    },
  } as unknown as RumConfiguration

  function idb<T>(request: IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error as Error)
    })
  }

  function openDb() {
    const request = indexedDB.open(UNSENT_EVENTS_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(UNSENT_EVENTS_STORE, { keyPath: 'pageId' })
    return idb(request)
  }

  async function putRecords(...records: UnsentRecord[]) {
    const db = await openDb()
    const transaction = db.transaction(UNSENT_EVENTS_STORE, 'readwrite')
    records.forEach((record) => transaction.objectStore(UNSENT_EVENTS_STORE).put(record))
    await new Promise((resolve) => (transaction.oncomplete = resolve))
    db.close()
  }

  async function readRecords() {
    const db = await openDb()
    const records = await idb(db.transaction(UNSENT_EVENTS_STORE).objectStore(UNSENT_EVENTS_STORE).getAll())
    db.close()
    return records as UnsentRecord[]
  }

  async function waitFor(condition: () => Promise<boolean> | boolean, timeout = 4000) {
    const start = Date.now()
    while (!(await condition())) {
      if (Date.now() - start > timeout) {
        throw new Error('condition not met')
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50))
    }
  }

  function start() {
    const mirror = startUnsentEventsMirror(configuration)
    registerCleanupTask(mirror.stop)
    return mirror
  }

  function orphan(overrides: Partial<UnsentRecord> = {}): UnsentRecord {
    const now = Date.now()
    return {
      pageId: 'dead-page',
      applicationId: 'app',
      messages: ['{"type":"action"}', '{"type":"view"}'],
      flushAfter: now - 1000,
      updatedAt: now - 2000,
      ...overrides,
    }
  }

  beforeEach(async () => {
    await idb(indexedDB.deleteDatabase(UNSENT_EVENTS_DB))
    fetchSpy = spyOn(window, 'fetch').and.callFake(() => Promise.resolve(new Response(null, { status: 202 })))
    registerCleanupTask(() => {
      indexedDB.deleteDatabase(UNSENT_EVENTS_DB)
    })
  })

  it('keeps a copy of the unsent messages', async () => {
    const before = Date.now()
    start().onPendingChange(['a', 'b'])

    await waitFor(async () => (await readRecords()).length === 1)
    const [record] = await readRecords()
    expect(record.messages).toEqual(['a', 'b'])
    expect(record.applicationId).toBe('app')
    expect(record.flushAfter).toBeGreaterThanOrEqual(before + ORPHAN_DELAY)
  })

  it('removes the copy once the messages are handed to the request', async () => {
    const mirror = start()
    mirror.onPendingChange(['a'])
    await waitFor(async () => (await readRecords()).length === 1)

    mirror.onPendingChange([])

    await waitFor(async () => (await readRecords()).length === 0)
  })

  it('sends the copy a dead page left, tagged as recovered, then removes it', async () => {
    await putRecords(orphan())

    start()

    await waitFor(() => fetchSpy.calls.count() === 1)
    const [url, init] = fetchSpy.calls.mostRecent().args as [string, RequestInit]
    expect(url).toContain('recovered=true')
    expect(init.body).toBe('{"type":"action"}\n{"type":"view"}')
    await waitFor(async () => (await readRecords()).length === 0)
  })

  it('leaves copies that may still belong to a live page, and other applications', async () => {
    await putRecords(
      orphan({ pageId: 'recent', flushAfter: Date.now() + ORPHAN_DELAY }),
      orphan({ pageId: 'other-app', applicationId: 'other' })
    )

    start()
    await new Promise((resolve) => window.setTimeout(resolve, 500))

    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await readRecords()).map((record) => record.pageId).sort()).toEqual(['other-app', 'recent'])
  })

  it('sends a copy once when several pages start together', async () => {
    await putRecords(orphan())

    start()
    start()

    await waitFor(async () => (await readRecords()).length === 0)
    await new Promise((resolve) => window.setTimeout(resolve, 300))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps the copy for a later page when sending fails', async () => {
    fetchSpy.and.callFake(() => Promise.resolve(new Response(null, { status: 500 })))
    await putRecords(orphan())

    start()

    await waitFor(() => fetchSpy.calls.count() === 1)
    await new Promise((resolve) => window.setTimeout(resolve, 300))
    const [record] = await readRecords()
    expect(record.claimedAt).toBeDefined()
  })

  it('drops copies too old for the intake to accept', async () => {
    await putRecords(orphan({ updatedAt: Date.now() - RECOVERED_MAX_AGE - 1000 }))

    start()

    await waitFor(async () => (await readRecords()).length === 0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('keepNewest', () => {
  it('drops the oldest messages beyond the limit', () => {
    expect(keepNewest(['aa', 'bb', 'cc'], 4)).toEqual(['bb', 'cc'])
    expect(keepNewest(['aa', 'bb'], MIRROR_MAX_BYTES)).toEqual(['aa', 'bb'])
    expect(keepNewest(['toolong'], 3)).toEqual([])
  })
})
