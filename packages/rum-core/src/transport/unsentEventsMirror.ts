import {
  ONE_DAY,
  ONE_KIBI_BYTE,
  ONE_MINUTE,
  ONE_SECOND,
  clearTimeout,
  computeBytesCount,
  dateNow,
  generateUUID,
  noop,
  setTimeout,
} from '@flashcatcloud/browser-core'
import type { TimeoutId } from '@flashcatcloud/browser-core'
import type { RumConfiguration } from '../domain/configuration'

export const UNSENT_EVENTS_DB = '_fc_rum'
export const UNSENT_EVENTS_STORE = 'unsent'

/** The copy is written at most this often: writing on every event costs too much CPU. */
export const MIRROR_WRITE_INTERVAL = ONE_SECOND
/**
 * A live page sends what it holds within the batch flush timeout (30 s) while visible, and at once
 * when hidden; data older than this belongs to a page that died.
 */
export const ORPHAN_DELAY = ONE_MINUTE
/** A claim older than this is taken to have failed (the claiming page died too). */
export const CLAIM_TIMEOUT = ONE_MINUTE
/** Matches how late the intake accepts recovered events. */
export const RECOVERED_MAX_AGE = 7 * ONE_DAY
/** Room for one batch (16 KB by default) with margin; the oldest messages go first beyond it. */
export const MIRROR_MAX_BYTES = 64 * ONE_KIBI_BYTE

export interface UnsentRecord {
  pageId: string
  applicationId: string
  messages: string[]
  flushAfter: number
  updatedAt: number
  claimedBy?: string
  claimedAt?: number
}

/**
 * FLASHCAT FORK - keeps a copy of the RUM events this page has not sent yet in IndexedDB, and sends
 * the copies other pages left behind.
 *
 * A page that leaves normally sends what it holds on its way out (pageMayExit). One whose renderer
 * crashes, or whose browser is killed, cannot: the batch dies with it. Its copy stays in IndexedDB,
 * and the next page of the same site and application sends it, tagged `recovered` so the intake
 * accepts it late and drops what the page did manage to send. No page is judged alive or dead: a
 * copy whose oldest event is older than ORPHAN_DELAY cannot belong to a live page. Several new pages
 * may find the same copy; the one whose transaction claims it sends it.
 *
 * Only the RUM batch is mirrored, not session replay segments.
 */
export function startUnsentEventsMirror(configuration: RumConfiguration) {
  const indexedDB = getIndexedDB()
  if (!indexedDB) {
    return { onPendingChange: noop, stop: noop }
  }

  const pageId = generateUUID()
  const applicationId = configuration.applicationId
  let db: IDBDatabase | undefined
  let latest: string[] = []
  let firstPendingAt: number | undefined
  let lastWriteAt = 0
  let writeTimeoutId: TimeoutId | undefined
  let stopped = false

  openDatabase(indexedDB, (opened) => {
    if (stopped) {
      opened.close()
      return
    }
    db = opened
    recoverOrphans(opened)
    if (latest.length) {
      scheduleWrite()
    }
  })

  function onPendingChange(messages: string[]) {
    if (!messages.length) {
      // Handed to the request: nothing left to lose.
      latest = []
      firstPendingAt = undefined
      clearTimeout(writeTimeoutId)
      writeTimeoutId = undefined
      if (db) {
        deleteRecord(db, pageId)
      }
      return
    }
    if (firstPendingAt === undefined) {
      firstPendingAt = dateNow()
    }
    latest = messages
    scheduleWrite()
  }

  function scheduleWrite() {
    if (writeTimeoutId !== undefined || !db) {
      return
    }
    const delay = Math.max(0, lastWriteAt + MIRROR_WRITE_INTERVAL - dateNow())
    writeTimeoutId = setTimeout(() => {
      writeTimeoutId = undefined
      if (!db || !latest.length || firstPendingAt === undefined) {
        return
      }
      lastWriteAt = dateNow()
      putRecord(db, {
        pageId,
        applicationId,
        messages: keepNewest(latest, MIRROR_MAX_BYTES),
        flushAfter: firstPendingAt + ORPHAN_DELAY,
        updatedAt: lastWriteAt,
      })
    }, delay)
  }

  function recoverOrphans(database: IDBDatabase) {
    readAllRecords(database, (records) => {
      const now = dateNow()
      for (const record of records) {
        if (record.updatedAt < now - RECOVERED_MAX_AGE) {
          deleteRecord(database, record.pageId)
        } else if (isClaimable(record, now)) {
          claimRecord(database, record.pageId, (claimed) => sendRecovered(database, claimed))
        }
      }
    })
  }

  function isClaimable(record: UnsentRecord, now: number) {
    return (
      record.pageId !== pageId &&
      record.applicationId === applicationId &&
      record.flushAfter <= now &&
      (record.claimedAt === undefined || record.claimedAt < now - CLAIM_TIMEOUT)
    )
  }

  function claimRecord(database: IDBDatabase, id: string, callback: (record: UnsentRecord) => void) {
    try {
      // Read and claim in one transaction: of several pages starting together, one claims it.
      const transaction = database.transaction(UNSENT_EVENTS_STORE, 'readwrite')
      const store = transaction.objectStore(UNSENT_EVENTS_STORE)
      let claimed: UnsentRecord | undefined
      const request = store.get(id)
      request.onsuccess = () => {
        const record = request.result as UnsentRecord | undefined
        if (record && isClaimable(record, dateNow())) {
          claimed = { ...record, claimedBy: pageId, claimedAt: dateNow() }
          store.put(claimed)
        }
      }
      transaction.oncomplete = () => {
        if (claimed) {
          callback(claimed)
        }
      }
    } catch {
      // the database is unusable: leave the copy for a later page
    }
  }

  function sendRecovered(database: IDBDatabase, record: UnsentRecord) {
    const data = record.messages.join('\n')
    const url = configuration.rumEndpointBuilder.build('fetch', {
      data,
      bytesCount: computeBytesCount(data),
      recovered: true,
    })
    fetch(url, { method: 'POST', body: data, mode: 'cors' }).then((response) => {
      if (response.ok) {
        deleteRecord(database, record.pageId)
      }
      // otherwise the claim expires and a later page tries again
    }, noop)
  }

  return {
    onPendingChange,
    stop: () => {
      stopped = true
      clearTimeout(writeTimeoutId)
      if (db) {
        db.close()
      }
    },
  }
}

/** The newest messages that fit in maxBytes, oldest first (string length as an estimate). */
export function keepNewest(messages: string[], maxBytes: number) {
  let total = 0
  let start = messages.length
  while (start > 0 && total + messages[start - 1].length <= maxBytes) {
    start -= 1
    total += messages[start].length
  }
  return messages.slice(start)
}

function getIndexedDB(): IDBFactory | undefined {
  try {
    return window.indexedDB || undefined
  } catch {
    // some privacy settings throw on access
    return undefined
  }
}

function openDatabase(indexedDB: IDBFactory, callback: (db: IDBDatabase) => void) {
  try {
    const request = indexedDB.open(UNSENT_EVENTS_DB, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(UNSENT_EVENTS_STORE, { keyPath: 'pageId' })
    }
    request.onsuccess = () => callback(request.result)
    request.onerror = noop
  } catch {
    // IndexedDB unusable (private mode in some browsers): nothing is mirrored
  }
}

function readAllRecords(db: IDBDatabase, callback: (records: UnsentRecord[]) => void) {
  try {
    const request = db.transaction(UNSENT_EVENTS_STORE, 'readonly').objectStore(UNSENT_EVENTS_STORE).getAll()
    request.onsuccess = () => callback(request.result as UnsentRecord[])
  } catch {
    // nothing to recover
  }
}

function putRecord(db: IDBDatabase, record: UnsentRecord) {
  try {
    db.transaction(UNSENT_EVENTS_STORE, 'readwrite').objectStore(UNSENT_EVENTS_STORE).put(record)
  } catch {
    // quota exceeded or database closed: the copy is skipped, sending is unaffected
  }
}

function deleteRecord(db: IDBDatabase, id: string) {
  try {
    db.transaction(UNSENT_EVENTS_STORE, 'readwrite').objectStore(UNSENT_EVENTS_STORE).delete(id)
  } catch {
    // the copy is left to expire
  }
}
