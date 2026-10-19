import Redis from 'ioredis';
import { getRedisConnection } from '../config/runtime';

const CACHE_PREFIX = 'cache:';

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(getRedisConnection());
  }
  return _redis;
}

/**
 * Cache-Aside helper.
 * On miss: calls `fetcher`, stores the result with TTL, then returns it.
 */
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const redis = getRedis();
  const cacheKey = `${CACHE_PREFIX}${key}`;

  const cached = await redis.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as T;
  }

  const value = await fetcher();
  if (value !== null && value !== undefined) {
    await redis.set(cacheKey, JSON.stringify(value), 'EX', ttlSeconds);
  }
  return value;
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
