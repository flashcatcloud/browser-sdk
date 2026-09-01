import type { ReplayStats } from '@flashcatcloud/browser-rum-core'

export const MAX_STATS_HISTORY = 1000
let statsPerView: Map<string, ReplayStats> | undefined

export function getSegmentsCount(viewId: string) {
  return getOrCreateReplayStats(viewId).segments_count
}

export function addSegment(viewId: string) {
  getOrCreateReplayStats(viewId).segments_count += 1
}

export function addRecord(viewId: string) {
  getOrCreateReplayStats(viewId).records_count += 1
}

export function addWroteData(viewId: string, additionalBytesCount: number) {
  getOrCreateReplayStats(viewId).segments_total_raw_size += additionalBytesCount
}

/**
 * Gives back the segment count {@link addSegment} took, and with it the `index_in_view` the segment
 * was holding. Undone in the same phase it was taken - synchronously - because the index is read at
 * creation: a segment created before this runs would hold an index the dropped one still occupies.
 */
export function removeSegment(viewId: string) {
  const replayStats = statsPerView?.get(viewId)
  if (!replayStats) {
    return
  }
  replayStats.segments_count = Math.max(0, replayStats.segments_count - 1)
}

/**
 * Rolls back what a dropped segment's records contributed. These are the counters reported on view
 * events, and a withheld segment that is dropped never reached the intake, so it must leave no
 * trace in them.
 */
export function discardSegmentData(viewId: string, rawBytesCount: number, recordsCount: number) {
  const replayStats = statsPerView?.get(viewId)
  if (!replayStats) {
    return
  }
  replayStats.records_count = Math.max(0, replayStats.records_count - recordsCount)
  replayStats.segments_total_raw_size = Math.max(0, replayStats.segments_total_raw_size - rawBytesCount)
}

export function getReplayStats(viewId: string) {
  return statsPerView?.get(viewId)
}

export function resetReplayStats() {
  statsPerView = undefined
}

function getOrCreateReplayStats(viewId: string) {
  if (!statsPerView) {
    statsPerView = new Map()
  }

  let replayStats: ReplayStats
  if (statsPerView.has(viewId)) {
    replayStats = statsPerView.get(viewId)!
  } else {
    replayStats = {
      records_count: 0,
      segments_count: 0,
      segments_total_raw_size: 0,
    }
    statsPerView.set(viewId, replayStats)
    if (statsPerView.size > MAX_STATS_HISTORY) {
      deleteOldestStats()
    }
  }

  return replayStats
}

function deleteOldestStats() {
  if (!statsPerView) {
    return
  }
  const toDelete = statsPerView.keys().next().value
  if (toDelete) {
    statsPerView.delete(toDelete)
  }
}
