import type { ClocksState, HttpRequest, TimeStamp } from '@flashcatcloud/browser-core'
import { DeflateEncoderStreamId, noop, PageExitReason } from '@flashcatcloud/browser-core'
import type { ViewHistory, ViewHistoryEntry, RumConfiguration } from '@flashcatcloud/browser-rum-core'
import { LifeCycle, LifeCycleEventType } from '@flashcatcloud/browser-rum-core'
import type { Clock } from '@flashcatcloud/browser-core/test'
import { mockClock, registerCleanupTask, restorePageVisibility } from '@flashcatcloud/browser-core/test'
import { createRumSessionManagerMock } from '../../../../rum-core/test'
import type { BrowserRecord, SegmentContext } from '../../types'
import { RecordType } from '../../types'
import { MockWorker, readMetadataFromReplayPayload } from '../../../test'
import { createDeflateEncoder } from '../deflate'
import * as replayStats from '../replayStats'
import {
  BUFFER_CHECKOUT_TIME,
  computeSegmentContext,
  doStartSegmentCollection,
  SEGMENT_BYTES_LIMIT,
  SEGMENT_DURATION_LIMIT,
} from './segmentCollection'

const CONTEXT: SegmentContext = { application: { id: 'a' }, view: { id: 'b' }, session: { id: 'c' } }
const RECORD: BrowserRecord = { type: RecordType.ViewEnd, timestamp: 10 as TimeStamp }

// A record that will make the segment size reach the SEGMENT_BYTES_LIMIT
const VERY_BIG_RECORD: BrowserRecord = {
  type: RecordType.FullSnapshot,
  timestamp: 10 as TimeStamp,
  data: Array(SEGMENT_BYTES_LIMIT).join('a') as any,
}

const BEFORE_SEGMENT_DURATION_LIMIT = SEGMENT_DURATION_LIMIT * 0.9

describe('startSegmentCollection', () => {
  let stopSegmentCollection: () => void
  let clock: Clock
  let lifeCycle: LifeCycle
  let worker: MockWorker
  let httpRequestSpy: {
    sendOnExit: jasmine.Spy<HttpRequest['sendOnExit']>
    send: jasmine.Spy<HttpRequest['send']>
  }
  let addRecord: (record: BrowserRecord) => void
  let context: SegmentContext | undefined
  let configuration: RumConfiguration

  function addRecordAndFlushSegment(flushStrategy: () => void = emulatePageUnload) {
    // Make sure the segment is not empty
    addRecord(RECORD)
    // Flush segment
    flushStrategy()
    worker.processAllMessages()
  }

  function emulatePageUnload() {
    lifeCycle.notify(LifeCycleEventType.PAGE_MAY_EXIT, { reason: PageExitReason.UNLOADING })
  }

  function readMostRecentMetadata(spy: jasmine.Spy<HttpRequest['send']>) {
    return readMetadataFromReplayPayload(spy.calls.mostRecent().args[0])
  }

  beforeEach(() => {
    configuration = {} as RumConfiguration
    lifeCycle = new LifeCycle()
    worker = new MockWorker()
    httpRequestSpy = {
      sendOnExit: jasmine.createSpy(),
      send: jasmine.createSpy(),
    }
    context = CONTEXT
    ;({ stop: stopSegmentCollection, addRecord } = doStartSegmentCollection(
      lifeCycle,
      () => context,
      httpRequestSpy,
      createDeflateEncoder(configuration, worker, DeflateEncoderStreamId.REPLAY),
      { getWithholdingSessionId: () => undefined, isReleased: () => false, restartFromFullSnapshot: noop }
    ))

    registerCleanupTask(() => {
      clock?.cleanup()
      stopSegmentCollection()
    })
  })

  describe('initial segment', () => {
    it('immediately starts a new segment', () => {
      expect(worker.pendingData).toBe('')
      addRecord(RECORD)
      expect(worker.pendingData).toBe('{"records":[{"type":7,"timestamp":10}')
      worker.processAllMessages()
      expect(httpRequestSpy.send).not.toHaveBeenCalled()
      expect(httpRequestSpy.sendOnExit).not.toHaveBeenCalled()
    })

    it('creation reason should reflect that it is the initial segment', async () => {
      addRecordAndFlushSegment()
      expect((await readMostRecentMetadata(httpRequestSpy.sendOnExit)).creation_reason).toBe('init')
    })
  })

  it('sends a segment', () => {
    addRecordAndFlushSegment()
    expect(httpRequestSpy.sendOnExit).toHaveBeenCalledTimes(1)
  })

  it("ignores calls to addRecord if context can't be get", () => {
    context = undefined
    addRecord(RECORD)
    emulatePageUnload()
    expect(worker.pendingData).toBe('')
    worker.processAllMessages()
    expect(httpRequestSpy.send).not.toHaveBeenCalled()
    expect(httpRequestSpy.sendOnExit).not.toHaveBeenCalled()
  })

  describe('segment flush strategy', () => {
    afterEach(() => {
      restorePageVisibility()
    })

    it('does not flush empty segments', () => {
      emulatePageUnload()
      worker.processAllMessages()
      expect(httpRequestSpy.send).not.toHaveBeenCalled()
      expect(httpRequestSpy.sendOnExit).not.toHaveBeenCalled()
    })

    describe('flush when the page exits because it is unloading', () => {
      it('uses `httpRequest.sendOnExit` when sending the segment', () => {
        addRecordAndFlushSegment(emulatePageUnload)
        expect(httpRequestSpy.sendOnExit).toHaveBeenCalled()
      })

      it('next segment is created because of beforeunload event', async () => {
        addRecordAndFlushSegment(emulatePageUnload)
        addRecordAndFlushSegment()
        expect((await readMostRecentMetadata(httpRequestSpy.sendOnExit)).creation_reason).toBe('before_unload')
      })
    })

    describe('flush when the page exits because it gets hidden', () => {
      function emulatePageHidden() {
        lifeCycle.notify(LifeCycleEventType.PAGE_MAY_EXIT, { reason: PageExitReason.HIDDEN })
      }

      it('uses `httpRequest.sendOnExit` when sending the segment', () => {
        addRecordAndFlushSegment(emulatePageHidden)
        expect(httpRequestSpy.sendOnExit).toHaveBeenCalled()
      })

      it('next segment is created because of visibility hidden event', async () => {
        addRecordAndFlushSegment(emulatePageHidden)
        addRecordAndFlushSegment()
        expect((await readMostRecentMetadata(httpRequestSpy.sendOnExit)).creation_reason).toBe('visibility_hidden')
      })
    })

    describe('flush when the page exits because it gets frozen', () => {
      function emulatePageFrozen() {
        lifeCycle.notify(LifeCycleEventType.PAGE_MAY_EXIT, { reason: PageExitReason.FROZEN })
      }

      it('uses `httpRequest.sendOnExit` when sending the segment', () => {
        addRecordAndFlushSegment(emulatePageFrozen)
        expect(httpRequestSpy.sendOnExit).toHaveBeenCalled()
      })

      it('next segment is created because of page freeze event', async () => {
        addRecordAndFlushSegment(emulatePageFrozen)
        addRecordAndFlushSegment()
        expect((await readMostRecentMetadata(httpRequestSpy.sendOnExit)).creation_reason).toBe('page_frozen')
      })
    })

    describe('flush when the view changes', () => {
      function emulateViewChange() {
        lifeCycle.notify(LifeCycleEventType.VIEW_CREATED, {} as any)
      }

      it('uses `httpRequest.send` when sending the segment', () => {
        addRecordAndFlushSegment(emulateViewChange)
        expect(httpRequestSpy.send).toHaveBeenCalled()
      })

      it('next segment is created because of view change', async () => {
        addRecordAndFlushSegment(emulateViewChange)
        addRecordAndFlushSegment()
        expect((await readMostRecentMetadata(httpRequestSpy.sendOnExit)).creation_reason).toBe('view_change')
      })
    })

    describe('flush when the page is re-activated', () => {
      function emulateReactivation() {
        lifeCycle.notify(LifeCycleEventType.PAGE_REACTIVATED)
      }

      it('uses `httpRequest.send` when sending the segment', () => {
        addRecordAndFlushSegment(emulateReactivation)
        expect(httpRequestSpy.send).toHaveBeenCalled()
      })

      it('next segment is created because of re-activation', async () => {
        addRecordAndFlushSegment(emulateReactivation)
        addRecordAndFlushSegment()
        expect((await readMostRecentMetadata(httpRequestSpy.sendOnExit)).creation_reason).toBe('view_change')
      })
    })

    describe('flush when reaching a bytes limit', () => {
      it('uses `httpRequest.send` when sending the segment', () => {
        addRecordAndFlushSegment(() => {
          addRecord(VERY_BIG_RECORD)
        })
        expect(httpRequestSpy.send).toHaveBeenCalled()
      })

      it('next segment is created because the bytes limit has been reached', async () => {
        addRecordAndFlushSegment(() => {
          addRecord(VERY_BIG_RECORD)
        })
        addRecordAndFlushSegment()

        expect((await readMostRecentMetadata(httpRequestSpy.sendOnExit)).creation_reason).toBe('segment_bytes_limit')
      })

      it('continues to add records to the current segment while the worker is processing messages', async () => {
        addRecord(VERY_BIG_RECORD)
        addRecord(RECORD)
        addRecord(RECORD)
        addRecord(RECORD)
        worker.processAllMessages()

        expect(httpRequestSpy.send).toHaveBeenCalledTimes(1)
        expect((await readMostRecentMetadata(httpRequestSpy.send)).records_count).toBe(4)
      })

      it('does not flush segment prematurely when records from the previous segment are still being processed', async () => {
        // Add two records to the current segment
        addRecord(VERY_BIG_RECORD)
        addRecord(RECORD)

        // Process only the first record. This should flush the current segment because it reached
        // the segment bytes limit.
        worker.processNextMessage()

        // Add a record to the new segment, to make sure it is not flushed even if it is not empty
        addRecord(RECORD)

        worker.processAllMessages()

        expect(httpRequestSpy.send).toHaveBeenCalledTimes(1)
        expect((await readMostRecentMetadata(httpRequestSpy.send)).records_count).toBe(2)
      })
    })

    describe('flush when a duration has been reached', () => {
      it('uses `httpRequest.send` when sending the segment', () => {
        clock = mockClock()
        addRecordAndFlushSegment(() => {
          clock!.tick(SEGMENT_DURATION_LIMIT)
        })
        expect(httpRequestSpy.send).toHaveBeenCalled()
      })

      it('next segment is created because of the segment duration limit has been reached', async () => {
        clock = mockClock()
        addRecordAndFlushSegment(() => {
          clock!.tick(SEGMENT_DURATION_LIMIT)
        })
        addRecordAndFlushSegment()
        expect((await readMostRecentMetadata(httpRequestSpy.sendOnExit)).creation_reason).toBe('segment_duration_limit')
      })

      it('does not flush a segment after SEGMENT_DURATION_LIMIT if a segment has been created in the meantime', async () => {
        clock = mockClock()
        addRecord(RECORD)
        clock.tick(BEFORE_SEGMENT_DURATION_LIMIT)
        emulatePageUnload()
        addRecord(RECORD)
        clock.tick(BEFORE_SEGMENT_DURATION_LIMIT)

        worker.processAllMessages()
        expect(httpRequestSpy.sendOnExit).toHaveBeenCalledTimes(1)
        addRecordAndFlushSegment()
        expect((await readMostRecentMetadata(httpRequestSpy.sendOnExit)).creation_reason).not.toBe(
          'segment_duration_limit'
        )
      })
    })

    describe('flush when stopping segment collection', () => {
      it('uses `httpRequest.send` when sending the segment', () => {
        addRecordAndFlushSegment(stopSegmentCollection)
        expect(httpRequestSpy.send).toHaveBeenCalled()
      })
    })
  })
})

describe('computeSegmentContext', () => {
  const DEFAULT_VIEW_CONTEXT: ViewHistoryEntry = { id: '123', startClocks: {} as ClocksState }
  const DEFAULT_SESSION = createRumSessionManagerMock().setId('456')

  it('returns a segment context', () => {
    expect(computeSegmentContext('appid', DEFAULT_SESSION, mockViewHistory(DEFAULT_VIEW_CONTEXT))).toEqual({
      application: { id: 'appid' },
      session: { id: '456' },
      view: { id: '123' },
    })
  })

  it('returns undefined if there is no current view', () => {
    expect(computeSegmentContext('appid', DEFAULT_SESSION, mockViewHistory(undefined))).toBeUndefined()
  })

  it('returns undefined if the session is not tracked', () => {
    expect(
      computeSegmentContext(
        'appid',
        createRumSessionManagerMock().setNotTracked(),
        mockViewHistory(DEFAULT_VIEW_CONTEXT)
      )
    ).toBeUndefined()
  })

  function mockViewHistory(view: ViewHistoryEntry | undefined): ViewHistory {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return {
      findView() {
        return view
      },
    } as any
  }
})

describe('startSegmentCollection withholding (error session replay)', () => {
  let clock: Clock
  let lifeCycle: LifeCycle
  let worker: MockWorker
  let httpRequestSpy: {
    sendOnExit: jasmine.Spy<HttpRequest['sendOnExit']>
    send: jasmine.Spy<HttpRequest['send']>
  }
  let addRecord: (record: BrowserRecord) => void
  let withholdingSessionId: string | undefined
  let releasedSessionId: string | undefined
  let restartFromFullSnapshotSpy: jasmine.Spy<() => void>
  let stopCollection: () => void

  function reportError() {
    releasedSessionId = withholdingSessionId
    withholdingSessionId = undefined
  }

  beforeEach(() => {
    clock = mockClock()
    lifeCycle = new LifeCycle()
    worker = new MockWorker()
    httpRequestSpy = { sendOnExit: jasmine.createSpy(), send: jasmine.createSpy() }
    withholdingSessionId = CONTEXT.session.id
    releasedSessionId = undefined
    restartFromFullSnapshotSpy = jasmine.createSpy()
    replayStats.resetReplayStats()

    const { stop, addRecord: add } = doStartSegmentCollection(
      lifeCycle,
      () => CONTEXT,
      httpRequestSpy,
      createDeflateEncoder({} as RumConfiguration, worker, DeflateEncoderStreamId.REPLAY),
      {
        getWithholdingSessionId: () => withholdingSessionId,
        isReleased: (sessionId) => releasedSessionId === sessionId,
        restartFromFullSnapshot: restartFromFullSnapshotSpy,
      }
    )
    addRecord = add
    stopCollection = stop

    registerCleanupTask(() => {
      stop()
      clock.cleanup()
      replayStats.resetReplayStats()
    })
  })

  it('releases a checkout still being encoded without reusing its segment index', async () => {
    addRecord({ ...RECORD, type: RecordType.FullSnapshot, data: {} } as BrowserRecord)
    worker.processAllMessages()
    clock.tick(BUFFER_CHECKOUT_TIME)
    reportError()
    lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, { type: 'error' } as any)
    addRecord(RECORD)
    clock.tick(SEGMENT_DURATION_LIMIT)
    worker.processAllMessages()
    clock.tick(SEGMENT_DURATION_LIMIT)
    worker.processAllMessages()
    const metadata = await Promise.all(
      httpRequestSpy.send.calls.allArgs().map(([payload]) => readMetadataFromReplayPayload(payload))
    )
    expect(metadata.map((segment) => segment.index_in_view)).toEqual([0, 1])
    expect(metadata[0]?.has_full_snapshot).toBeTrue()
  })

  it('remembers a release if recording ends before the worker answers', () => {
    addRecord(RECORD)
    worker.processAllMessages()
    clock.tick(BUFFER_CHECKOUT_TIME)
    reportError()
    lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, { type: 'error' } as any)
    stopCollection()
    releasedSessionId = undefined
    worker.processAllMessages()
    expect(httpRequestSpy.send).toHaveBeenCalledTimes(1)
  })

  it('drains records and a stop queued behind a released flush', async () => {
    addRecord(RECORD)
    worker.processAllMessages()
    clock.tick(BUFFER_CHECKOUT_TIME)
    addRecord(RECORD)
    reportError()
    stopCollection()
    releasedSessionId = undefined
    worker.processAllMessages()
    const metadata = await Promise.all(
      httpRequestSpy.send.calls.allArgs().map(([payload]) => readMetadataFromReplayPayload(payload))
    )
    expect(metadata.map((segment) => segment.index_in_view)).toEqual([0, 1])
    expect(metadata.map((segment) => segment.records_count)).toEqual([1, 1])
  })

  it('preserves encoder ordering when a new recording starts before the old flush completes', async () => {
    const sharedWorker = new MockWorker()
    const sharedEncoder = createDeflateEncoder({} as RumConfiguration, sharedWorker, DeflateEncoderStreamId.REPLAY)
    const sent: Array<Parameters<HttpRequest['send']>[0]> = []
    let released = false
    const request = { send: (payload: Parameters<HttpRequest['send']>[0]) => sent.push(payload), sendOnExit: noop }
    const first = doStartSegmentCollection(lifeCycle, () => CONTEXT, request, sharedEncoder, {
      getWithholdingSessionId: () => (released ? undefined : CONTEXT.session.id),
      isReleased: () => released,
      restartFromFullSnapshot: noop,
    })
    first.addRecord(RECORD)
    clock.tick(BUFFER_CHECKOUT_TIME)
    first.addRecord(RECORD)
    released = true
    first.stop()
    const second = doStartSegmentCollection(
      new LifeCycle(),
      () => ({ ...CONTEXT, session: { id: 'next-session' }, view: { id: 'next-view' } }),
      request,
      sharedEncoder,
      {
        getWithholdingSessionId: () => undefined,
        isReleased: () => false,
        restartFromFullSnapshot: noop,
      }
    )
    second.addRecord(RECORD)
    second.stop()
    sharedWorker.processAllMessages()
    const segments = await Promise.all(
      sent.map(
        async (payload) =>
          JSON.parse(await ((payload.data as FormData).get('segment') as Blob).text()) as {
            session: { id: string }
            records: BrowserRecord[]
            index_in_view: number
          }
      )
    )
    expect(segments.map((segment) => segment.session.id)).toEqual([
      CONTEXT.session.id,
      CONTEXT.session.id,
      'next-session',
    ])
    expect(segments.map((segment) => segment.index_in_view)).toEqual([0, 1, 0])
    expect(segments.map((segment) => segment.records.length)).toEqual([1, 1, 1])
  })

  it('never releases an unfinished flush for a different session', () => {
    addRecord(RECORD)
    clock.tick(BUFFER_CHECKOUT_TIME)
    releasedSessionId = 'different-session'
    stopCollection()
    worker.processAllMessages()
    expect(httpRequestSpy.send).not.toHaveBeenCalled()
  })

  it('does not send anything while the session has not reported an error', () => {
    addRecord(RECORD)
    clock.tick(SEGMENT_DURATION_LIMIT)
    worker.processAllMessages()

    expect(httpRequestSpy.send).not.toHaveBeenCalled()
    expect(httpRequestSpy.sendOnExit).not.toHaveBeenCalled()
  })

  it('keeps buffering across several duration limits instead of cutting the segment', () => {
    addRecord(RECORD)
    clock.tick(SEGMENT_DURATION_LIMIT * 3)
    addRecord(RECORD)
    worker.processAllMessages()

    expect(httpRequestSpy.send).not.toHaveBeenCalled()
    // still the same buffer: dropping it would have asked for a fresh full snapshot
    expect(restartFromFullSnapshotSpy).not.toHaveBeenCalled()
  })

  it('sends the withheld buffer once the session reports an error', async () => {
    addRecord(RECORD)
    addRecord(RECORD)
    clock.tick(SEGMENT_DURATION_LIMIT)
    worker.processAllMessages()
    expect(httpRequestSpy.send).not.toHaveBeenCalled()

    reportError()
    clock.tick(SEGMENT_DURATION_LIMIT)
    worker.processAllMessages()

    expect(httpRequestSpy.send).toHaveBeenCalledTimes(1)
    // the records collected before the error are part of what is sent
    expect((await readMetadataFromReplayPayload(httpRequestSpy.send.calls.mostRecent().args[0])).records_count).toBe(2)
  })

  it('drops the buffer and restarts from a full snapshot once it spans the checkout time', () => {
    addRecord(RECORD)
    clock.tick(BUFFER_CHECKOUT_TIME)
    worker.processAllMessages()

    expect(httpRequestSpy.send).not.toHaveBeenCalled()
    expect(restartFromFullSnapshotSpy).toHaveBeenCalledTimes(1)
  })

  it('drops the buffer and restarts from a full snapshot when it grows past the bytes limit', () => {
    addRecord(VERY_BIG_RECORD)
    worker.processAllMessages()

    expect(httpRequestSpy.send).not.toHaveBeenCalled()
    expect(restartFromFullSnapshotSpy).toHaveBeenCalledTimes(1)
  })

  it('does not restart in a hot loop when the full snapshot alone exceeds the bytes limit', () => {
    // every restart would blow the limit again straight away on such a document
    addRecord(VERY_BIG_RECORD)
    worker.processAllMessages()
    addRecord(VERY_BIG_RECORD)
    worker.processAllMessages()
    addRecord(VERY_BIG_RECORD)
    worker.processAllMessages()

    expect(restartFromFullSnapshotSpy).toHaveBeenCalledTimes(1)

    clock.tick(SEGMENT_DURATION_LIMIT)
    addRecord(VERY_BIG_RECORD)
    worker.processAllMessages()

    expect(restartFromFullSnapshotSpy).toHaveBeenCalledTimes(2)
  })

  it('restores a full snapshot after consecutive oversized snapshots and an error', async () => {
    restartFromFullSnapshotSpy.and.callFake(() => addRecord(VERY_BIG_RECORD))
    addRecord(VERY_BIG_RECORD)
    worker.processAllMessages()
    expect(httpRequestSpy.send).not.toHaveBeenCalled()
    expect(restartFromFullSnapshotSpy).toHaveBeenCalledTimes(1)

    reportError()
    addRecord(RECORD)
    clock.tick(SEGMENT_DURATION_LIMIT)
    worker.processAllMessages()
    clock.tick(SEGMENT_DURATION_LIMIT)
    worker.processAllMessages()

    expect(httpRequestSpy.send).toHaveBeenCalled()
    expect(
      (await readMetadataFromReplayPayload(httpRequestSpy.send.calls.first().args[0])).has_full_snapshot
    ).toBeTrue()
  })

  it('restores a missing snapshot before an errored page exits during the restart delay', async () => {
    restartFromFullSnapshotSpy.and.callFake(() => addRecord(VERY_BIG_RECORD))
    addRecord(VERY_BIG_RECORD)
    worker.processAllMessages()
    reportError()
    addRecord(RECORD)
    lifeCycle.notify(LifeCycleEventType.PAGE_MAY_EXIT, { reason: PageExitReason.UNLOADING })
    worker.processAllMessages()

    expect(httpRequestSpy.sendOnExit).toHaveBeenCalled()
    expect(
      (await readMetadataFromReplayPayload(httpRequestSpy.sendOnExit.calls.first().args[0])).has_full_snapshot
    ).toBeTrue()
  })

  it('restores the missing snapshot as soon as an error releases the session', () => {
    restartFromFullSnapshotSpy.and.callFake(() => addRecord(VERY_BIG_RECORD))
    addRecord(VERY_BIG_RECORD)
    worker.processAllMessages()
    reportError()
    lifeCycle.notify(LifeCycleEventType.RUM_EVENT_COLLECTED, { type: 'error' } as any)

    expect(restartFromFullSnapshotSpy).toHaveBeenCalledTimes(2)
    worker.processAllMessages()
    expect(httpRequestSpy.send).toHaveBeenCalled()
  })

  it('cancels the delayed replacement when a new view supplies a snapshot', () => {
    restartFromFullSnapshotSpy.and.callFake(() => addRecord(VERY_BIG_RECORD))
    addRecord(VERY_BIG_RECORD)
    worker.processAllMessages()
    lifeCycle.notify(LifeCycleEventType.VIEW_CREATED, {} as any)
    addRecord({ ...VERY_BIG_RECORD, data: {} } as BrowserRecord)
    worker.processAllMessages()
    clock.tick(SEGMENT_DURATION_LIMIT)
    worker.processAllMessages()

    expect(restartFromFullSnapshotSpy).toHaveBeenCalledTimes(1)
    expect(httpRequestSpy.send).not.toHaveBeenCalled()
  })

  it('does not repeatedly serialize an oversized document while waiting for an error', () => {
    restartFromFullSnapshotSpy.and.callFake(() => addRecord(VERY_BIG_RECORD))
    addRecord(VERY_BIG_RECORD)
    worker.processAllMessages()
    for (let i = 0; i < 4; i++) {
      clock.tick(SEGMENT_DURATION_LIMIT)
      worker.processAllMessages()
    }

    expect(restartFromFullSnapshotSpy).toHaveBeenCalledTimes(1)
    expect(httpRequestSpy.send).not.toHaveBeenCalled()
  })

  it('cancels a delayed snapshot when recording stops', () => {
    restartFromFullSnapshotSpy.and.callFake(() => addRecord(VERY_BIG_RECORD))
    addRecord(VERY_BIG_RECORD)
    worker.processAllMessages()
    stopCollection()
    clock.tick(SEGMENT_DURATION_LIMIT * 2)
    worker.processAllMessages()

    expect(restartFromFullSnapshotSpy).toHaveBeenCalledTimes(1)
    expect(httpRequestSpy.send).not.toHaveBeenCalled()
  })

  it('keeps the buffer when the page is only hidden, so the replay can still start from its snapshot', () => {
    // switching tabs is ordinary; dropping here would take the only full snapshot with it
    addRecord(RECORD)
    addRecord(RECORD)
    lifeCycle.notify(LifeCycleEventType.PAGE_MAY_EXIT, { reason: PageExitReason.HIDDEN })
    worker.processAllMessages()

    expect(httpRequestSpy.sendOnExit).not.toHaveBeenCalled()
    expect(restartFromFullSnapshotSpy).not.toHaveBeenCalled()

    reportError()
    clock.tick(SEGMENT_DURATION_LIMIT)
    worker.processAllMessages()

    expect(httpRequestSpy.send).toHaveBeenCalledTimes(1)
  })

  it('sends nothing on page exit for a session that never errored', () => {
    addRecord(RECORD)
    lifeCycle.notify(LifeCycleEventType.PAGE_MAY_EXIT, { reason: PageExitReason.UNLOADING })
    worker.processAllMessages()

    expect(httpRequestSpy.sendOnExit).not.toHaveBeenCalled()
  })

  it('does not let a dropped buffer leave its index_in_view behind for the next one to collide with', async () => {
    // the restart emits records, exactly as taking a fresh full snapshot does in production
    restartFromFullSnapshotSpy.and.callFake(() => addRecord(RECORD))

    addRecord(RECORD)
    clock.tick(BUFFER_CHECKOUT_TIME)
    worker.processAllMessages()
    expect(restartFromFullSnapshotSpy).toHaveBeenCalledTimes(1)

    reportError()
    clock.tick(SEGMENT_DURATION_LIMIT)
    worker.processAllMessages()

    // the dropped buffer never reached the intake, so the first segment that does is index 0
    const metadata = await readMetadataFromReplayPayload(httpRequestSpy.send.calls.mostRecent().args[0])
    expect(metadata.index_in_view).toBe(0)
    // and it carries a reason the segment schema knows, not the internal one that dropped the buffer
    expect(metadata.creation_reason).toBe('segment_duration_limit')
  })

  it('does not restart the buffer when collection was stopped while the flush was in flight', () => {
    addRecord(RECORD)
    // the checkout flush is posted to the worker, and recording is stopped before it answers
    clock.tick(BUFFER_CHECKOUT_TIME)
    stopCollection()
    worker.processAllMessages()

    expect(restartFromFullSnapshotSpy).not.toHaveBeenCalled()
  })

  it('does not hand the next segment an index the dropped one still holds when a record lands mid-flush', async () => {
    restartFromFullSnapshotSpy.and.callFake(() => addRecord(RECORD))

    addRecord(RECORD)
    // The flush is posted to the worker but not answered yet - in production that round trip always
    // happens, because flushing writes the trailer before finishing. A record arriving now creates
    // the next segment, which reads its index while the dropped one is still counted.
    clock.tick(BUFFER_CHECKOUT_TIME)
    addRecord(RECORD)
    worker.processAllMessages()

    reportError()
    clock.tick(SEGMENT_DURATION_LIMIT)
    worker.processAllMessages()

    expect((await readMetadataFromReplayPayload(httpRequestSpy.send.calls.mostRecent().args[0])).index_in_view).toBe(0)
  })

  it('leaves no trace of a dropped buffer in the replay stats', () => {
    addRecord(RECORD)
    clock.tick(BUFFER_CHECKOUT_TIME)
    worker.processAllMessages()

    const stats = replayStats.getReplayStats(CONTEXT.view.id)
    expect(stats?.segments_count ?? 0).toBe(0)
    expect(stats?.segments_total_raw_size ?? 0).toBe(0)
  })

  it('sends normally once released, without withholding the following segments', () => {
    reportError()
    addRecord(RECORD)
    clock.tick(SEGMENT_DURATION_LIMIT)
    worker.processAllMessages()
    addRecord(RECORD)
    clock.tick(SEGMENT_DURATION_LIMIT)
    worker.processAllMessages()

    expect(httpRequestSpy.send).toHaveBeenCalledTimes(2)
  })
})

describe('startSegmentCollection withholding, session lifecycle', () => {
  let clock: Clock
  let lifeCycle: LifeCycle
  let worker: MockWorker
  let httpRequestSpy: {
    sendOnExit: jasmine.Spy<HttpRequest['sendOnExit']>
    send: jasmine.Spy<HttpRequest['send']>
  }
  let addRecord: (record: BrowserRecord) => void
  let stopSegmentCollection: () => void
  let withholdingSessionId: string | undefined
  let releasedSessionId: string | undefined

  beforeEach(() => {
    clock = mockClock()
    lifeCycle = new LifeCycle()
    worker = new MockWorker()
    httpRequestSpy = { sendOnExit: jasmine.createSpy(), send: jasmine.createSpy() }
    withholdingSessionId = CONTEXT.session.id
    releasedSessionId = undefined

    const { stop, addRecord: add } = doStartSegmentCollection(
      lifeCycle,
      () => CONTEXT,
      httpRequestSpy,
      createDeflateEncoder({} as RumConfiguration, worker, DeflateEncoderStreamId.REPLAY),
      {
        getWithholdingSessionId: () => withholdingSessionId,
        isReleased: (sessionId) => releasedSessionId === sessionId,
        restartFromFullSnapshot: () => undefined,
      }
    )
    addRecord = add
    stopSegmentCollection = stop

    registerCleanupTask(() => {
      stopSegmentCollection()
      clock.cleanup()
    })
  })

  it('drops the buffer when the session expires without ever reporting an error', () => {
    addRecord(RECORD)
    // the session is gone, so nothing answers for these records any more
    withholdingSessionId = undefined
    releasedSessionId = undefined

    stopSegmentCollection()
    worker.processAllMessages()

    expect(httpRequestSpy.send).not.toHaveBeenCalled()
    expect(httpRequestSpy.sendOnExit).not.toHaveBeenCalled()
  })

  it('drops the buffer when the session is renewed into a different one', () => {
    addRecord(RECORD)
    withholdingSessionId = undefined
    releasedSessionId = 'a-different-session'

    stopSegmentCollection()
    worker.processAllMessages()

    expect(httpRequestSpy.send).not.toHaveBeenCalled()
    expect(httpRequestSpy.sendOnExit).not.toHaveBeenCalled()
  })

  it('sends the buffer when its own session reports the error', () => {
    addRecord(RECORD)
    releasedSessionId = withholdingSessionId
    withholdingSessionId = undefined

    stopSegmentCollection()
    worker.processAllMessages()

    expect(httpRequestSpy.send).toHaveBeenCalledTimes(1)
  })
})
