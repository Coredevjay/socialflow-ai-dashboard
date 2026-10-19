import Redis from 'ioredis';
import { redis } from '../lib/redis';
import { createLogger } from '../lib/logger';
import { authBlacklistRedisErrorsTotal, authBlacklistFallbackHitsTotal } from '../lib/metrics';

const logger = createLogger('AuthBlacklistService');

const BLACKLIST_PREFIX = 'jwt:blacklist:';

// In-memory LRU fallback for recently blacklisted tokens.
// NOTE: this cache is per-process and only contains tokens revoked by this
// replica, so it is NOT a substitute for Redis across replicas.
const LRU_MAX = 1000;
const lruCache = new Map<string, number>(); // key -> expiry epoch ms (insertion order == recency order)

function lruSet(key: string, ttlSeconds: number): void {
  // Delete first so re-inserting moves the key to the most-recently-used end.
  lruCache.delete(key);
  if (lruCache.size >= LRU_MAX) {
    // Evict the least-recently-used entry (first in insertion order).
    const oldestKey = lruCache.keys().next().value;
    if (oldestKey !== undefined) lruCache.delete(oldestKey);
  }
  lruCache.set(key, Date.now() + ttlSeconds * 1000);
}

function lruHas(key: string): boolean {
  const expiry = lruCache.get(key);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    lruCache.delete(key);
    return false;
  }
  // Refresh recency: delete-then-set moves the key to the MRU end.
  lruCache.delete(key);
  lruCache.set(key, expiry);
  return true;
}

/**
 * Whether blacklist checks should fail closed (deny the request) when Redis
 * is unavailable. Defaults to true: an outage must not silently re-enable
 * revoked tokens. Set AUTH_BLACKLIST_FAIL_CLOSED=false to opt into fail-open
 * behaviour backed by the per-process fallback cache.
 */
function isFailClosed(): boolean {
  const raw = process.env.AUTH_BLACKLIST_FAIL_CLOSED;
  if (raw === undefined) return true;
  return raw.toLowerCase() !== 'false' && raw !== '0';
}

function incrementRedisErrorCounter(): void {
  authBlacklistRedisErrorsTotal.inc();
}

/**
 * Parses a JWT expiry string (e.g. "15m", "7d", "1h") into seconds.
 * Falls back to the provided default if parsing fails.
 */
function parseTTLSeconds(value: string | undefined, fallbackSeconds: number): number {
  if (!value) return fallbackSeconds;
  const match = value.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return fallbackSeconds;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return n * multipliers[unit];
}

function getRedis(): Redis {
  return redis;
}

/**
 * Thrown by isBlacklisted when Redis is unavailable and the blacklist is
 * configured to fail closed. Callers should translate this to HTTP 503.
 */
export class AuthBlacklistUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthBlacklistUnavailableError';
  }
}

export const AuthBlacklistService = {
  /**
   * Blacklist an access token until it naturally expires.
   * @param jti  - unique token identifier (jti claim); falls back to sub+iat as key
   * @param ttlSeconds - remaining lifetime of the token in seconds
   */
  blacklistToken: async (tokenKey: string, ttlSeconds: number): Promise<void> => {
    if (ttlSeconds <= 0) return; // already expired, nothing to store
    lruSet(tokenKey, ttlSeconds);
    try {
      await getRedis().set(`${BLACKLIST_PREFIX}${tokenKey}`, '1', 'EX', ttlSeconds);
    } catch (err) {
      logger.warn('Redis unavailable — token blacklist write skipped', { tokenKey, err });
    }
  },

  /**
   * Returns true if the token has been blacklisted.
   *
   * On Redis error the policy is explicit:
   *  - fail-closed (default, AUTH_BLACKLIST_FAIL_CLOSED unset/true): throws
   *    AuthBlacklistUnavailableError so callers can respond 503 instead of
   *    accepting a possibly-revoked token.
   *  - fail-open (AUTH_BLACKLIST_FAIL_CLOSED=false): falls back to the
   *    per-process LRU cache and records a fallback-hit metric.
   */
  isBlacklisted: async (tokenKey: string): Promise<boolean> => {
    try {
      const result = await getRedis().get(`${BLACKLIST_PREFIX}${tokenKey}`);
      return result !== null;
    } catch (err) {
      incrementRedisErrorCounter();
      if (isFailClosed()) {
        logger.error('Redis unavailable for blacklist check — failing closed', { tokenKey, err });
        throw new AuthBlacklistUnavailableError('Token blacklist unavailable', { cause: err });
      }
      authBlacklistFallbackHitsTotal.inc();
      logger.warn('Redis unavailable for blacklist check — falling back to LRU cache', { tokenKey, err });
      return lruHas(tokenKey);
    }
  },

  /**
   * Derive a stable cache key from JWT payload fields.
   * Prefers jti (unique per token, added to access tokens so two tokens issued
   * to the same subject in the same second do not collide). Falls back to
   * "<sub>:<iat>" only for legacy tokens issued before jti was added, so we
   * never store the raw token.
   */
  keyFromPayload: (payload: { sub?: string; jti?: string; iat?: number }): string => {
    if (payload.jti) return payload.jti;
    return `${payload.sub ?? 'unknown'}:${payload.iat ?? 0}`;
  },

  /**
   * Compute remaining TTL in seconds for an access token.
   */
  accessTokenTTL: (): number => {
    return parseTTLSeconds(process.env.JWT_EXPIRES_IN, 15 * 60); // default 15 min
  },
};
