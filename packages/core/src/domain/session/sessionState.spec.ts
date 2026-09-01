import { dateNow } from '../../tools/utils/timeUtils'
import { SESSION_EXPIRATION_DELAY, SESSION_TIME_OUT_DELAY } from './sessionConstants'
import type { SessionState } from './sessionState'
import {
  expandSessionState,
  getExpireDate,
  isSessionInExpiredState,
  toSessionString,
  toSessionState,
  isSessionInNotStartedState,
} from './sessionState'

describe('session state utilities', () => {
  const NOT_STARTED_SESSION: SessionState = {}
  const SERIALIZED_NOT_STARTED_SESSION = ''
  const EXPIRED_SESSION: SessionState = { isExpired: '1' }
  const SERIALIZED_EXPIRED_SESSION = 'isExpired=1'
  const LIVE_SESSION: SessionState = { id: '123', first: 'tracked' }
  const SERIALIZED_LIVE_SESSION = 'id=123&first=tracked'

  describe('isSessionStarted', () => {
    it('should correctly identify a session in a started state', () => {
      expect(isSessionInNotStartedState(LIVE_SESSION)).toBe(false)
      expect(isSessionInNotStartedState(EXPIRED_SESSION)).toBe(false)
    })

    it('should correctly identify a session in a not started state', () => {
      expect(isSessionInNotStartedState(NOT_STARTED_SESSION)).toBe(true)
    })
  })

  describe('isSessionInExpiredState', () => {
    const ONE_DAY = 24 * 60 * 60 * 1000

    function dateNowWithOffset(offset = 0) {
      return String(dateNow() + offset)
    }

    it('should correctly identify a session in expired state', () => {
      expect(isSessionInExpiredState(EXPIRED_SESSION)).toBe(true)
      expect(
        isSessionInExpiredState({
          created: dateNowWithOffset(-SESSION_TIME_OUT_DELAY),
          expire: dateNowWithOffset(1000),
        })
      ).toBe(true)
      expect(isSessionInExpiredState({ created: dateNowWithOffset(-100), expire: dateNowWithOffset(-100) })).toBe(true)
    })

    it('should expire a session that cannot say when it started or when it lapses', () => {
      // A missing stamp used to short-circuit the comparison to `true`. See getExpireDate.
      expect(isSessionInExpiredState({ first: 'not-tracked' })).toBe(true)
      expect(isSessionInExpiredState({ first: 'tracked' })).toBe(true)
      expect(isSessionInExpiredState({ id: '123', first: 'tracked', expire: dateNowWithOffset(1000) })).toBe(true)
      expect(isSessionInExpiredState({ id: '123', first: 'tracked', created: dateNowWithOffset(-1000) })).toBe(true)
    })

    it('should cap the sliding deadline at SESSION_TIME_OUT_DELAY from creation', () => {
      // An `expire` beyond the cap can only come from a clock that was ahead when it was written,
      // and would otherwise hold the session open until that error had elapsed for real.
      expect(
        isSessionInExpiredState({
          created: dateNowWithOffset(-SESSION_TIME_OUT_DELAY),
          expire: dateNowWithOffset(ONE_DAY),
        })
      ).toBe(true)
    })

    it('should correctly identify a session in live state', () => {
      expect(isSessionInExpiredState({ created: dateNowWithOffset(-1000), expire: dateNowWithOffset(1000) })).toBe(
        false
      )
    })

    it('should not consider a session that was never started as expired', () => {
      expect(isSessionInExpiredState(NOT_STARTED_SESSION)).toBe(false)
    })
  })

  describe('getExpireDate', () => {
    function dateNowWithOffset(offset = 0) {
      return String(dateNow() + offset)
    }

    it('should return undefined without an expire stamp', () => {
      expect(getExpireDate({})).toBeUndefined()
      expect(getExpireDate({ created: dateNowWithOffset(-1000) })).toBeUndefined()
    })

    it('should return undefined when a session holding an id has no creation date', () => {
      expect(getExpireDate({ id: '123', expire: dateNowWithOffset(1000) })).toBeUndefined()
    })

    it('should fall back to expire alone for a not-tracked session, which is never stamped', () => {
      const expire = dateNowWithOffset(1000)
      expect(getExpireDate({ first: 'not-tracked', expire })).toBe(Number(expire))
    })

    it('should return the sliding deadline while it is the earlier of the two', () => {
      const expire = dateNowWithOffset(1000)
      expect(getExpireDate({ created: dateNowWithOffset(-1000), expire })).toBe(Number(expire))
    })

    it('should return the creation cap once it is the earlier of the two', () => {
      const created = dateNowWithOffset(-SESSION_TIME_OUT_DELAY + 1000)
      expect(getExpireDate({ created, expire: dateNowWithOffset(SESSION_TIME_OUT_DELAY) })).toBe(
        Number(created) + SESSION_TIME_OUT_DELAY
      )
    })
  })

  describe('toSessionString', () => {
    it('should serialize a sessionState to a string', () => {
      expect(toSessionString(LIVE_SESSION)).toEqual(SERIALIZED_LIVE_SESSION)
    })

    it('should handle empty sessionStates', () => {
      expect(toSessionString(EXPIRED_SESSION)).toEqual(SERIALIZED_EXPIRED_SESSION)
    })
  })

  describe('sessionStringToSessionState', () => {
    it('should deserialize a session string to a sessionState', () => {
      expect(toSessionState(SERIALIZED_LIVE_SESSION)).toEqual(LIVE_SESSION)
    })

    it('should handle empty session strings', () => {
      expect(toSessionState(SERIALIZED_NOT_STARTED_SESSION)).toEqual(NOT_STARTED_SESSION)
    })

    it('should handle expired session', () => {
      expect(toSessionState(SERIALIZED_EXPIRED_SESSION)).toEqual(EXPIRED_SESSION)
    })

    it('should handle invalid session strings', () => {
      const sessionString = '{invalid: true}'
      expect(toSessionState(sessionString)).toEqual(NOT_STARTED_SESSION)
    })
  })

  describe('expandSessionState', () => {
    it('should modify the expire property of the session', () => {
      const session = { ...LIVE_SESSION }
      const now = dateNow()
      expandSessionState(session)
      expect(session.expire).toBeGreaterThanOrEqual(now + SESSION_EXPIRATION_DELAY)
    })
  })
})
