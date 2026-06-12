import { LifeCycleEventType, getScrollX, getScrollY, getViewportDimension } from '@flashcatcloud/browser-rum-core'
import type { RumConfiguration, LifeCycle } from '@flashcatcloud/browser-rum-core'
import { timeStampNow } from '@flashcatcloud/browser-core'
import type { BrowserRecord } from '../../types'
import { RecordType } from '../../types'
import type { ElementsScrollPositions } from './elementsScrollPositions'
import type { ShadowRootsController } from './shadowRootsController'
import { SerializationContextStatus, serializeDocument } from './serialization'
import { getVisualViewport } from './viewports'

export function startFullSnapshots(
  elementsScrollPositions: ElementsScrollPositions,
  shadowRootsController: ShadowRootsController,
  lifeCycle: LifeCycle,
  configuration: RumConfiguration,
  flushMutations: () => void,
  fullSnapshotCallback: (records: BrowserRecord[]) => void
) {
  const takeFullSnapshot = (
    timestamp = timeStampNow(),
    serializationContext = {
      status: SerializationContextStatus.INITIAL_FULL_SNAPSHOT,
      elementsScrollPositions,
      shadowRootsController,
    }
  ) => {
    const { width, height } = getViewportDimension()
    const records: BrowserRecord[] = [
      {
        data: {
          height,
          href: window.location.href,
          width,
        },
        type: RecordType.Meta,
        timestamp,
      },
      {
        data: {
          has_focus: document.hasFocus(),
        },
        type: RecordType.Focus,
        timestamp,
      },
      {
        data: {
          node: serializeDocument(document, configuration, serializationContext),
          initialOffset: {
            left: getScrollX(),
            top: getScrollY(),
          },
        },
        type: RecordType.FullSnapshot,
        timestamp,
      },
    ]

    if (window.visualViewport) {
      records.push({
        data: getVisualViewport(window.visualViewport),
        type: RecordType.VisualViewport,
        timestamp,
      })
    }
    return records
  }

  fullSnapshotCallback(takeFullSnapshot())

  const { unsubscribe: unsubscribeViewCreated } = lifeCycle.subscribe(LifeCycleEventType.VIEW_CREATED, (view) => {
    flushMutations()
    fullSnapshotCallback(
      takeFullSnapshot(view.startClocks.timeStamp, {
        shadowRootsController,
        status: SerializationContextStatus.SUBSEQUENT_FULL_SNAPSHOT,
        elementsScrollPositions,
      })
    )
  })

  // When the page is re-activated (window/tab switched back to), take a fresh full snapshot so the
  // new segment has its own baseline instead of inheriting another window/tab's snapshot. The
  // segment is flushed first by segmentCollection, which subscribes to PAGE_REACTIVATED earlier.
  const { unsubscribe: unsubscribeReactivated } = lifeCycle.subscribe(LifeCycleEventType.PAGE_REACTIVATED, () => {
    flushMutations()
    fullSnapshotCallback(
      takeFullSnapshot(timeStampNow(), {
        shadowRootsController,
        status: SerializationContextStatus.SUBSEQUENT_FULL_SNAPSHOT,
        elementsScrollPositions,
      })
    )
  })

  return {
    stop: () => {
      unsubscribeViewCreated()
      unsubscribeReactivated()
    },
  }
}
