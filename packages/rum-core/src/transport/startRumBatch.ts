import type {
  Context,
  TelemetryEvent,
  Observable,
  RawError,
  PageMayExitEvent,
  Encoder,
} from '@flashcatcloud/browser-core'
import {
  DeflateEncoderStreamId,
  combine,
  isTelemetryReplicationAllowed,
  startBatchWithReplica,
} from '@flashcatcloud/browser-core'
import type { RumConfiguration } from '../domain/configuration'
import type { LifeCycle } from '../domain/lifeCycle'
import type { RumSessionManager } from '../domain/rumSessionManager'
import { RumEventType } from '../rawRumEvent.types'
import type { RumEvent } from '../rumEvent.types'
import { startWithheldEventBuffer } from './withheldEventBuffer'

export function startRumBatch(
  configuration: RumConfiguration,
  lifeCycle: LifeCycle,
  telemetryEventObservable: Observable<TelemetryEvent & Context>,
  reportError: (error: RawError) => void,
  pageMayExitObservable: Observable<PageMayExitEvent>,
  sessionManager: RumSessionManager,
  createEncoder: (streamId: DeflateEncoderStreamId) => Encoder
) {
  const replica = configuration.replica

  const batch = startBatchWithReplica(
    configuration,
    {
      endpoint: configuration.rumEndpointBuilder,
      encoder: createEncoder(DeflateEncoderStreamId.RUM),
    },
    replica && {
      endpoint: replica.rumEndpointBuilder,
      transformMessage: (message) => combine(message, { application: { id: replica.applicationId } }),
      encoder: createEncoder(DeflateEncoderStreamId.RUM_REPLICA),
    },
    reportError,
    pageMayExitObservable,
    sessionManager.expireObservable
  )

  // Events reach the batch through the buffer, which either forwards them straight away or withholds
  // them until the session reports an error. A session that never errors uploads nothing at all.
  startWithheldEventBuffer(lifeCycle, sessionManager, (serverRumEvent: RumEvent & Context) => {
    if (serverRumEvent.type === RumEventType.VIEW) {
      batch.upsert(serverRumEvent, serverRumEvent.view.id)
    } else {
      batch.add(serverRumEvent)
    }
  })

  telemetryEventObservable.subscribe((event) => batch.add(event, isTelemetryReplicationAllowed(configuration)))

  return batch
}
