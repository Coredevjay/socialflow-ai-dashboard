import Redis from 'ioredis';
import { redis } from '../lib/redis';
import { createLogger } from '../lib/logger';

const logger = createLogger('AccountLockoutService');

/**
 * Per-account failed-login lockout, keyed by user id or email — independent
 * of the caller's IP. Mirrors the policy already used for 2FA verification
 * in TwoFactorLockoutService, applied here to the primary login flow, which
 * previously had no protection beyond the IP-scoped authLimiter.
 */
export interface AccountLockoutStore {
  recordFailedAttempt(accountKey: string): Promise<void>;
  isLockedOut(accountKey: string): Promise<boolean>;
  getLockoutRemainingMs(accountKey: string): Promise<number>;
  resetFailedAttempts(accountKey: string): Promise<void>;
}

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_S = 15 * 60; // 15 minutes
const PREFIX = 'login:lockout:';
const ATTEMPTS_SUFFIX = ':attempts';
const LOCKED_SUFFIX = ':locked_until';

// The shared Redis client is configured with maxRetriesPerRequest: null
// (see config/runtime.ts), so a command issued while Redis is unreachable
// queues forever instead of rejecting. Since this store sits directly in the
// login hot path, an unbounded await here would turn a Redis outage into a
// total login outage. Bound every call so a stall degrades to "fail open"
// instead of hanging the request indefinitely.
const REDIS_CALL_TIMEOUT_MS = 500;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis call timed out')), REDIS_CALL_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function getRedis(): Redis {
  return redis;
}

/**
 * Normalise the account key so case/whitespace variants of the same email
 * (e.g. `A@x.com` vs `a@x.com`) share a single lockout counter and cannot be
 * rotated to bypass the threshold.
 */
function normaliseAccountKey(accountKey: string): string {
  return accountKey.trim().toLowerCase();
}

/**
 * Redis calls fail open (never block a login on their own): if Redis is
 * unavailable or slow to respond, attempts simply aren't tracked rather than
 * every login hanging or erroring — matching the fallback posture already
 * used by AuthBlacklistService for token blacklisting.
 */
export const redisAccountLockoutStore: AccountLockoutStore = {
  async recordFailedAttempt(accountKey: string): Promise<void> {
    try {
      const key = normaliseAccountKey(accountKey);
      const attemptsKey = `${PREFIX}${key}${ATTEMPTS_SUFFIX}`;
      const lockedKey = `${PREFIX}${key}${LOCKED_SUFFIX}`;

      const attempts = await withTimeout(getRedis().incr(attemptsKey));
      await withTimeout(getRedis().expire(attemptsKey, LOCKOUT_DURATION_S));

      if (attempts >= LOCKOUT_THRESHOLD) {
        await withTimeout(getRedis().set(lockedKey, '1', 'EX', LOCKOUT_DURATION_S));
      }
    } catch (err) {
      logger.warn('Redis unavailable — failed login attempt not recorded', { err });
    }
  },

  async isLockedOut(accountKey: string): Promise<boolean> {
    try {
      const key = normaliseAccountKey(accountKey);
      const result = await withTimeout(getRedis().get(`${PREFIX}${key}${LOCKED_SUFFIX}`));
      return result !== null;
    } catch (err) {
      logger.warn('Redis unavailable — account lockout check skipped', { err });
      return false;
    }
  },

  async getLockoutRemainingMs(accountKey: string): Promise<number> {
    try {
      const key = normaliseAccountKey(accountKey);
      const ttl = await withTimeout(getRedis().pttl(`${PREFIX}${key}${LOCKED_SUFFIX}`));
      return ttl > 0 ? ttl : 0;
    } catch (err) {
      logger.warn('Redis unavailable — could not compute lockout remaining time', { err });
      return 0;
    }
  },

  async resetFailedAttempts(accountKey: string): Promise<void> {
    try {
      const key = normaliseAccountKey(accountKey);
      await withTimeout(
        getRedis().del(`${PREFIX}${key}${ATTEMPTS_SUFFIX}`, `${PREFIX}${key}${LOCKED_SUFFIX}`),
      );
    } catch (err) {
      logger.warn('Redis unavailable — could not reset failed login attempts', { err });
    }
  },
};
