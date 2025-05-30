import { noop } from '@flashcatcloud/browser-core'
import type { UrlContexts } from '../src/domain/contexts/urlContexts'
import type { ViewHistory, ViewHistoryEntry } from '../src/domain/contexts/viewHistory'

export function mockUrlContexts(fakeLocation: Location = location): UrlContexts {
  return {
    findUrl: () => ({
      url: fakeLocation.href,
      referrer: document.referrer,
    }),
    stop: noop,
  }
}

export function mockViewHistory(view?: Partial<ViewHistoryEntry>): ViewHistory {
  return {
    findView: () => view as ViewHistoryEntry,
    stop: noop,
  }
}
