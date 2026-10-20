import Redis from 'ioredis';
import { getRedisConnection } from '../config/runtime';
import { createLogger } from '../lib/logger';

const logger = createLogger('cache');
const CACHE_PREFIX = 'cache:';

/**
 * Sentinel value stored in Redis to represent a negative result
 * (fetcher returned null or undefined).  Storing an explicit entry
 * prevents repeated cache misses for known-missing keys and is the
 * mechanism behind stampede protection for negative results.
 *
 * Exported so tests can assert on the exact stored value without
 * hardcoding the string.
 */
export const SENTINEL = '__NULL__';

/**
 * In-process single-flight map.
 *
 * Keys are the full namespaced cache keys (`cache:<key>`).  While a
 * fetcher is running for a given key, every concurrent call that also
 * misses Redis attaches to the same Promise instead of spawning a new
 * fetcher invocation.  The entry is removed once the promise settles,
 * so subsequent calls (after the TTL expires) start a fresh fetch.
 *
 * Exported so tests can inspect and clear the map between runs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inflight = new Map<string, Promise<any>>();

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(getRedisConnection());
  }
  return _redis;
}

/**
 * Options bag for {@link withCache}.
 */
export interface WithCacheOptions {
  /**
   * TTL (seconds) used when the fetcher returns `null` or `undefined`.
   * Defaults to `ttlSeconds` so the negative result expires at the same
   * time as a positive one would.  Pass a smaller value (e.g. 30) to
   * recheck the upstream source sooner for records that are likely to
   * appear later (e.g. eventually-consistent writes).
   */
  negativeTtlSeconds?: number;
}

/**
 * Cache-Aside helper with stampede protection, negative-result caching, and
 * corrupted-entry recovery.
 *
 * ## Cache hit
 * Returns the deserialised value immediately.  If the stored value is the
 * {@link SENTINEL}, `null` is returned — the upstream was previously
 * confirmed absent and the negative result is being served from cache.
 *
 * If the stored value cannot be parsed as JSON (corrupted entry or schema
 * written by an older code version), the bad key is deleted and the request
 * falls through to the fetch path as a cache miss.  A warning is logged so
 * the event is observable without crashing the request.
 *
 * ## Cache miss — single-flight
 * If no in-flight fetch is already running for `key`, a new fetcher
 * invocation is started and registered in {@link inflight}.  Every
 * concurrent caller that also misses Redis **for the same key** attaches
 * to that same Promise and receives the same result, so the fetcher is
 * called at most once per cache interval regardless of request concurrency.
 *
 * ## Negative-result caching
 * When the fetcher returns `null` or `undefined`, the {@link SENTINEL} is
 * stored in Redis with `negativeTtlSeconds` (defaulting to `ttlSeconds`).
 * This prevents a stampede on the upstream every time a non-existent key
 * is requested.  The caller still receives `null` / `undefined` — the
 * sentinel is an internal implementation detail.
 *
 * @param key            - Business key (namespaced internally with `cache:`).
 * @param ttlSeconds     - TTL for positive results.
 * @param fetcher        - Async function that fetches the value on a miss.
 * @param options        - Optional overrides (see {@link WithCacheOptions}).
 */
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
  options?: WithCacheOptions,
): Promise<T> {
  const redis = getRedis();
  const cacheKey = `${CACHE_PREFIX}${key}`;

  // ── 1. Cache hit ──────────────────────────────────────────────────────────
  const cached = await redis.get(cacheKey);
  if (cached !== null) {
    // Sentinel → the upstream was previously confirmed absent; return null.
    if (cached === JSON.stringify(SENTINEL)) {
      return null as unknown as T;
    }

    // Parse the cached value.  If the entry is corrupted or was written by an
    // older code version with a different shape, JSON.parse throws a
    // SyntaxError.  Rather than letting that propagate and failing the
    // request, we treat it as a miss: delete the bad key and fall through to
    // the fetch path so the caller gets a fresh, valid result.
    try {
      return JSON.parse(cached) as T;
    } catch (err) {
      logger.warn('Cache entry could not be parsed — deleting and treating as miss', {
        cacheKey,
        error: err instanceof Error ? err.message : String(err),
        rawLength: cached.length,
      });
      // Fire-and-forget deletion; if it fails the key will expire naturally.
      redis.unlink(cacheKey).catch(() => {});
      // Fall through to the fetch path below.
    }
  }

  // ── 2. Single-flight: reuse an in-flight fetch if one is already running ──
  const existing = inflight.get(cacheKey);
  if (existing) {
    return existing as Promise<T>;
  }

  // ── 3. New fetch ──────────────────────────────────────────────────────────
  const negativeTtl = options?.negativeTtlSeconds ?? ttlSeconds;

  const fetchPromise: Promise<T> = fetcher().then(
    (value) => {
      inflight.delete(cacheKey);
      if (value !== null && value !== undefined) {
        // Positive result — cache with the normal TTL.
        redis.set(cacheKey, JSON.stringify(value), 'EX', ttlSeconds).catch(() => {
          // Fire-and-forget; a failed write is not fatal — next request will
          // miss and fetch again.
        });
      } else {
        // Negative result — store sentinel so future requests are served from
        // cache instead of hitting the upstream on every call.
        redis.set(cacheKey, JSON.stringify(SENTINEL), 'EX', negativeTtl).catch(() => {});
      }
      return value;
    },
    (err) => {
      // On fetcher error, remove from inflight so the next caller retries.
      inflight.delete(cacheKey);
      throw err;
    },
  );

  inflight.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/** Glob metacharacters understood by Redis SCAN MATCH. */
const GLOB_PATTERN = /[*?[\]]/;

/**
 * Walk the keyspace with SCAN and UNLINK each page as soon as it is read.
 * Deleting per page keeps memory bounded for large keyspaces — buffering
 * every match before a single UNLINK can hold the whole keyspace in memory.
 */
async function unlinkByPattern(redis: Redis, fullPattern: string): Promise<void> {
  let cursor = '0';

  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', fullPattern, 'COUNT', 100);
    cursor = next;
    if (batch.length > 0) {
      await redis.unlink(...batch);
    }
  } while (cursor !== '0');
}

/**
 * Delete one or more cache keys. Keys containing glob metacharacters
 * (`*`, `?`, `[...]`) are expanded through SCAN and UNLINK; plain keys are
 * deleted with a single pipeline so the common case stays one round-trip.
 */
export async function invalidateCache(...keys: string[]): Promise<void> {
  const redis = getRedis();
  const literalKeys: string[] = [];

  for (const key of keys) {
    if (GLOB_PATTERN.test(key)) {
      await unlinkByPattern(redis, `${CACHE_PREFIX}${key}`);
    } else {
      literalKeys.push(`${CACHE_PREFIX}${key}`);
    }
  }

  if (literalKeys.length === 0) {
    return;
  }

  const pipeline = redis.pipeline();
  for (const key of literalKeys) {
    pipeline.del(key);
  }
  await pipeline.exec();
}

/** Delete all cache keys matching a pattern (e.g. "org:*"). */
export async function invalidateCachePattern(pattern: string): Promise<void> {
  await unlinkByPattern(getRedis(), `${CACHE_PREFIX}${pattern}`);
}

export const CacheTTL = {
  USER_PROFILE: 300,      // 5 minutes
  ORG: 300,               // 5 minutes
  ORG_LIST: 120,          // 2 minutes
  ANALYTICS: 60,          // 1 minute
  FEED: 30,               // 30 seconds
} as const;
