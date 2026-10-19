/**
 * cache.test.ts
 *
 * Unit tests for the cache utility (src/utils/cache.ts).
 * Covers withCache, invalidateCache, and invalidateCachePattern.
 *
 * Redis is mocked entirely in-memory — no live Redis connection needed.
 * Each test starts with a clean store via beforeEach.
 */

// ── In-memory Redis mock ──────────────────────────────────────────────────────

const store = new Map<string, string>();

/** Minimal glob match: only handles the '*' wildcard used in Redis SCAN patterns. */
function matchPattern(key: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${regexStr}$`).test(key);
}

let _pipelineKeys: string[] = [];

interface MockPipeline {
  del: jest.Mock<MockPipeline, [string]>;
  exec: jest.Mock<Promise<unknown[]>, []>;
}

const mockPipeline: MockPipeline = {
  del: jest.fn((key: string) => {
    _pipelineKeys.push(key);
    return mockPipeline;
  }),
  exec: jest.fn(async () => {
    _pipelineKeys.forEach(k => store.delete(k));
    _pipelineKeys = [];
    return [];
  }),
};

const mockRedis = {
  get: jest.fn(async (key: string) => store.get(key) ?? null),
  set: jest.fn(async (key: string, value: string, _ex: string, _ttl: number) => {
    store.set(key, value);
    return 'OK';
  }),
  unlink: jest.fn(async (...keys: string[]) => {
    keys.forEach(k => store.delete(k));
    return keys.length;
  }),
  scan: jest.fn(async (cursor: string, _m: string, pattern: string, _c: string, _n: number) => {
    // Single-shot scan: return all matching keys on the first call, then done.
    if (cursor !== '0') return ['0', [] as string[]];
    const matching = [...store.keys()].filter(k => matchPattern(k, pattern));
    return ['0', matching] as [string, string[]];
  }),
  pipeline: jest.fn(() => {
    _pipelineKeys = [];
    return mockPipeline;
  }),
};

jest.mock('ioredis', () => jest.fn(() => mockRedis));

jest.mock('../../config/runtime', () => ({
  getRedisConnection: () => ({ host: '127.0.0.1', port: 6379 }),
}));

const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../lib/logger', () => ({ createLogger: () => mockLogger }));

// ── Import SUT after mocks ────────────────────────────────────────────────────

import { withCache, invalidateCache, invalidateCachePattern, SENTINEL, inflight } from '../cache';

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  store.clear();
  _pipelineKeys = [];
  jest.clearAllMocks();
  // Clear the in-process single-flight map so tests start with a clean slate.
  inflight.clear();
  mockLogger.warn.mockClear();

  mockRedis.get.mockImplementation(async (key: string) => store.get(key) ?? null);
  mockRedis.set.mockImplementation(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  });
  mockRedis.unlink.mockImplementation(async (...keys: string[]) => {
    keys.forEach(k => store.delete(k));
    return keys.length;
  });
  mockRedis.scan.mockImplementation(async (cursor: string, _m: string, pattern: string) => {
    if (cursor !== '0') return ['0', []];
    const matching = [...store.keys()].filter(k => matchPattern(k, pattern));
    return ['0', matching];
  });
  mockPipeline.del.mockImplementation((key: string) => {
    _pipelineKeys.push(key);
    return mockPipeline;
  });
  mockPipeline.exec.mockImplementation(async () => {
    _pipelineKeys.forEach(k => store.delete(k));
    _pipelineKeys = [];
    return [];
  });
  mockRedis.pipeline.mockImplementation(() => {
    _pipelineKeys = [];
    return mockPipeline;
  });
});

// ── withCache ─────────────────────────────────────────────────────────────────

describe('withCache()', () => {
  it('calls fetcher on cache miss and returns its value', async () => {
    const fetcher = jest.fn().mockResolvedValue({ id: 1 });
    const result = await withCache('user:1', 300, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: 1 });
  });

  it('stores the result in Redis with the cache: namespace prefix', async () => {
    const fetcher = jest.fn().mockResolvedValue('hello');
    await withCache('greeting', 60, fetcher);
    expect(store.has('cache:greeting')).toBe(true);
  });

  it('stores the result using the correct TTL', async () => {
    const fetcher = jest.fn().mockResolvedValue(42);
    await withCache('counter', 120, fetcher);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'cache:counter',
      JSON.stringify(42),
      'EX',
      120,
    );
  });

  it('returns the cached value on a subsequent call without invoking fetcher again', async () => {
    const fetcher = jest.fn().mockResolvedValue({ name: 'Alice' });
    await withCache('user:alice', 300, fetcher);
    const second = await withCache('user:alice', 300, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ name: 'Alice' });
  });

  it('returns a parsed object (not raw JSON string) on cache hit', async () => {
    store.set('cache:obj', JSON.stringify({ x: 99 }));
    const fetcher = jest.fn();
    const result = await withCache('obj', 60, fetcher);
    expect(result).toEqual({ x: 99 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stores the SENTINEL entry when fetcher returns null (negative-result caching)', async () => {
    const fetcher = jest.fn().mockResolvedValue(null);
    await withCache('nothing', 60, fetcher);
    // flush fire-and-forget redis.set
    await Promise.resolve();
    // A sentinel entry must be present so repeated requests are served from
    // cache instead of hitting the upstream on every miss.
    expect(store.has('cache:nothing')).toBe(true);
    expect(store.get('cache:nothing')).toBe(JSON.stringify(SENTINEL));
    expect(mockRedis.set).toHaveBeenCalledWith(
      'cache:nothing',
      JSON.stringify(SENTINEL),
      'EX',
      60,
    );
  });

  it('stores the SENTINEL entry when fetcher returns undefined (negative-result caching)', async () => {
    const fetcher = jest.fn().mockResolvedValue(undefined);
    await withCache('undef', 60, fetcher);
    await Promise.resolve();
    expect(store.has('cache:undef')).toBe(true);
    expect(store.get('cache:undef')).toBe(JSON.stringify(SENTINEL));
    expect(mockRedis.set).toHaveBeenCalledWith(
      'cache:undef',
      JSON.stringify(SENTINEL),
      'EX',
      60,
    );
  });

  it('still returns null when fetcher returns null (no cache bypass)', async () => {
    const fetcher = jest.fn().mockResolvedValue(null);
    const result = await withCache('empty', 60, fetcher);
    expect(result).toBeNull();
  });

  it('different keys are cached independently', async () => {
    await withCache('a', 60, jest.fn().mockResolvedValue('A'));
    await withCache('b', 60, jest.fn().mockResolvedValue('B'));
    expect(store.get('cache:a')).toBe('"A"');
    expect(store.get('cache:b')).toBe('"B"');
  });

  it('calls fetcher again after the cache key is manually deleted', async () => {
    const fetcher = jest.fn().mockResolvedValue('fresh');
    await withCache('item', 60, fetcher);
    store.delete('cache:item');
    await withCache('item', 60, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// ── invalidateCache ───────────────────────────────────────────────────────────

describe('invalidateCache()', () => {
  it('deletes exactly the namespaced key from Redis', async () => {
    store.set('cache:user:1', '{"id":1}');
    await invalidateCache('user:1');
    expect(store.has('cache:user:1')).toBe(false);
  });

  it('does not delete unrelated keys', async () => {
    store.set('cache:user:1', '{"id":1}');
    store.set('cache:user:2', '{"id":2}');
    await invalidateCache('user:1');
    expect(store.has('cache:user:2')).toBe(true);
  });

  it('uses a pipeline (batches the delete operation)', async () => {
    await invalidateCache('any:key');
    expect(mockRedis.pipeline).toHaveBeenCalled();
    expect(mockPipeline.del).toHaveBeenCalledWith('cache:any:key');
    expect(mockPipeline.exec).toHaveBeenCalled();
  });

  it('deletes multiple keys in a single pipeline call', async () => {
    store.set('cache:k1', '1');
    store.set('cache:k2', '2');
    await invalidateCache('k1', 'k2');
    expect(store.has('cache:k1')).toBe(false);
    expect(store.has('cache:k2')).toBe(false);
  });

  it('is a no-op when the key does not exist', async () => {
    await expect(invalidateCache('nonexistent')).resolves.toBeUndefined();
  });

  it('adds the cache: prefix to each key passed', async () => {
    await invalidateCache('org:5', 'post:7');
    expect(mockPipeline.del).toHaveBeenCalledWith('cache:org:5');
    expect(mockPipeline.del).toHaveBeenCalledWith('cache:post:7');
  });

  it('expands glob patterns through SCAN and deletes every match', async () => {
    store.set('cache:org:1:posts', 'a');
    store.set('cache:org:1:users', 'b');
    store.set('cache:org:2:posts', 'c');

    await invalidateCache('org:1:*');

    expect(store.has('cache:org:1:posts')).toBe(false);
    expect(store.has('cache:org:1:users')).toBe(false);
    expect(store.has('cache:org:2:posts')).toBe(true);
    expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'cache:org:1:*', 'COUNT', 100);
    expect(mockRedis.unlink).toHaveBeenCalled();
  });

  it('handles literal and glob keys in the same call', async () => {
    store.set('cache:user:1', '{"id":1}');
    store.set('cache:org:1:posts', 'a');
    store.set('cache:org:1:users', 'b');

    await invalidateCache('user:1', 'org:1:*');

    expect(store.has('cache:user:1')).toBe(false);
    expect(store.has('cache:org:1:posts')).toBe(false);
    expect(store.has('cache:org:1:users')).toBe(false);
    expect(mockPipeline.del).toHaveBeenCalledWith('cache:user:1');
    expect(mockPipeline.del).not.toHaveBeenCalledWith('cache:org:1:*');
  });

  it('is a no-op for a glob that matches nothing', async () => {
    store.set('cache:user:1', '{"id":1}');

    await expect(invalidateCache('missing:*')).resolves.toBeUndefined();

    expect(store.has('cache:user:1')).toBe(true);
    expect(mockRedis.unlink).not.toHaveBeenCalled();
    expect(mockRedis.pipeline).not.toHaveBeenCalled();
  });
});

// ── invalidateCachePattern ────────────────────────────────────────────────────

describe('invalidateCachePattern()', () => {
  it('deletes all keys matching the pattern', async () => {
    store.set('cache:org:1:posts', 'a');
    store.set('cache:org:1:users', 'b');
    store.set('cache:org:2:posts', 'c');
    await invalidateCachePattern('org:1:*');
    expect(store.has('cache:org:1:posts')).toBe(false);
    expect(store.has('cache:org:1:users')).toBe(false);
  });

  it('does not delete keys that do not match the pattern', async () => {
    store.set('cache:org:1:posts', 'a');
    store.set('cache:org:2:posts', 'c');
    await invalidateCachePattern('org:1:*');
    expect(store.has('cache:org:2:posts')).toBe(true);
  });

  it('prepends the cache: namespace to the SCAN pattern', async () => {
    await invalidateCachePattern('org:*');
    expect(mockRedis.scan).toHaveBeenCalledWith(
      '0', 'MATCH', 'cache:org:*', 'COUNT', 100,
    );
  });

  it('uses unlink (not del) to remove matched keys', async () => {
    store.set('cache:temp:1', 'x');
    await invalidateCachePattern('temp:*');
    expect(mockRedis.unlink).toHaveBeenCalled();
  });

  it('is a no-op when no keys match the pattern', async () => {
    store.set('cache:user:1', 'x');
    await expect(invalidateCachePattern('org:*')).resolves.toBeUndefined();
    expect(mockRedis.unlink).not.toHaveBeenCalled();
  });

  it('deletes all keys across multiple matching namespaces', async () => {
    store.set('cache:session:a', '1');
    store.set('cache:session:b', '2');
    store.set('cache:session:c', '3');
    await invalidateCachePattern('session:*');
    expect(store.size).toBe(0);
  });

  it('unlinks each SCAN page as it is read instead of buffering the keyspace', async () => {
    mockRedis.scan.mockImplementation(async (cursor: string) => {
      if (cursor === '0') return ['7', ['cache:batch:a', 'cache:batch:b']] as [string, string[]];
      return ['0', ['cache:batch:c']] as [string, string[]];
    });

    await invalidateCachePattern('batch:*');

    expect(mockRedis.scan).toHaveBeenCalledTimes(2);
    expect(mockRedis.unlink).toHaveBeenNthCalledWith(1, 'cache:batch:a', 'cache:batch:b');
    expect(mockRedis.unlink).toHaveBeenNthCalledWith(2, 'cache:batch:c');
  });
});

// ── withCache – sentinel / negative-result caching (#1809) ───────────────────

describe('withCache() – sentinel / negative-result caching', () => {
  it('stores the SENTINEL value when fetcher returns null', async () => {
    const fetcher = jest.fn().mockResolvedValue(null);
    await withCache('missing:1', 60, fetcher);

    // Allow the fire-and-forget redis.set to complete
    await Promise.resolve();

    expect(mockRedis.set).toHaveBeenCalledWith(
      'cache:missing:1',
      JSON.stringify(SENTINEL),
      'EX',
      60,
    );
  });

  it('stores the SENTINEL value when fetcher returns undefined', async () => {
    const fetcher = jest.fn().mockResolvedValue(undefined);
    await withCache('missing:2', 60, fetcher);

    await Promise.resolve();

    expect(mockRedis.set).toHaveBeenCalledWith(
      'cache:missing:2',
      JSON.stringify(SENTINEL),
      'EX',
      60,
    );
  });

  it('returns null when the cached value is the SENTINEL', async () => {
    store.set('cache:missing:3', JSON.stringify(SENTINEL));
    const fetcher = jest.fn();
    const result = await withCache('missing:3', 60, fetcher);

    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not call fetcher again on a subsequent call when SENTINEL is cached', async () => {
    const fetcher = jest.fn().mockResolvedValue(null);
    await withCache('org:404', 60, fetcher);
    // flush fire-and-forget set
    await Promise.resolve();

    // second call: SENTINEL is now in the store
    const second = await withCache('org:404', 60, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBeNull();
  });

  it('uses negativeTtlSeconds for the SENTINEL entry when provided', async () => {
    const fetcher = jest.fn().mockResolvedValue(null);
    await withCache('org:neg', 300, fetcher, { negativeTtlSeconds: 30 });

    await Promise.resolve();

    expect(mockRedis.set).toHaveBeenCalledWith(
      'cache:org:neg',
      JSON.stringify(SENTINEL),
      'EX',
      30,
    );
  });

  it('still uses ttlSeconds for positive results even when negativeTtlSeconds is set', async () => {
    const fetcher = jest.fn().mockResolvedValue({ id: 7 });
    await withCache('org:pos', 300, fetcher, { negativeTtlSeconds: 30 });

    await Promise.resolve();

    expect(mockRedis.set).toHaveBeenCalledWith(
      'cache:org:pos',
      JSON.stringify({ id: 7 }),
      'EX',
      300,
    );
  });

  it('a positive result after a SENTINEL has been evicted is stored correctly', async () => {
    // Pre-populate with sentinel, then evict it, then fetch a real value.
    store.set('cache:org:5', JSON.stringify(SENTINEL));
    store.delete('cache:org:5');

    const fetcher = jest.fn().mockResolvedValue({ id: 5 });
    const result = await withCache('org:5', 60, fetcher);

    await Promise.resolve();

    expect(result).toEqual({ id: 5 });
    expect(mockRedis.set).toHaveBeenCalledWith(
      'cache:org:5',
      JSON.stringify({ id: 5 }),
      'EX',
      60,
    );
  });
});

// ── withCache – stampede protection / single-flight (#1809) ──────────────────

describe('withCache() – stampede protection (single-flight)', () => {
  it('calls fetcher exactly once when multiple concurrent misses occur for the same key', async () => {
    // All three miss Redis simultaneously (store is empty) and must share one
    // fetcher invocation.
    const fetcher = jest.fn().mockResolvedValue({ data: 'hot' });

    const [r1, r2, r3] = await Promise.all([
      withCache('hot:key', 60, fetcher),
      withCache('hot:key', 60, fetcher),
      withCache('hot:key', 60, fetcher),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ data: 'hot' });
    expect(r2).toEqual({ data: 'hot' });
    expect(r3).toEqual({ data: 'hot' });
  });

  it('all concurrent callers receive the same value', async () => {
    const fetcher = jest.fn().mockResolvedValue([1, 2, 3]);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => withCache('list:key', 60, fetcher)),
    );

    results.forEach((r) => expect(r).toEqual([1, 2, 3]));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('removes the inflight entry after the fetcher resolves', async () => {
    const fetcher = jest.fn().mockResolvedValue('done');
    await withCache('once:key', 60, fetcher);

    expect(inflight.has('cache:once:key')).toBe(false);
  });

  it('removes the inflight entry after the fetcher rejects', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('upstream error'));

    await expect(withCache('err:key', 60, fetcher)).rejects.toThrow('upstream error');

    expect(inflight.has('cache:err:key')).toBe(false);
  });

  it('allows a retry after a fetcher error (inflight entry removed on rejection)', async () => {
    const fetcher = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ ok: true });

    await expect(withCache('retry:key', 60, fetcher)).rejects.toThrow('transient');
    // inflight entry must have been removed
    expect(inflight.has('cache:retry:key')).toBe(false);

    const result = await withCache('retry:key', 60, fetcher);
    expect(result).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('independent keys have independent inflight entries and each call their own fetcher', async () => {
    const fetcherA = jest.fn().mockResolvedValue('A');
    const fetcherB = jest.fn().mockResolvedValue('B');

    const [a, b] = await Promise.all([
      withCache('sf:keyA', 60, fetcherA),
      withCache('sf:keyB', 60, fetcherB),
    ]);

    expect(fetcherA).toHaveBeenCalledTimes(1);
    expect(fetcherB).toHaveBeenCalledTimes(1);
    expect(a).toBe('A');
    expect(b).toBe('B');
  });

  it('a second call after the first has settled starts a fresh fetch (no stale inflight)', async () => {
    const fetcher = jest.fn().mockResolvedValue('fresh');

    await withCache('seq:key', 60, fetcher);
    // Evict from store to force a second miss
    store.delete('cache:seq:key');
    await withCache('seq:key', 60, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// ── withCache – corrupted-entry recovery (#1810) ──────────────────────────────

describe('withCache() – corrupted-entry recovery', () => {
  it('does not throw when a cached value is not valid JSON', async () => {
    store.set('cache:bad', 'not-valid-json{{{');
    const fetcher = jest.fn().mockResolvedValue({ id: 1 });
    await expect(withCache('bad', 60, fetcher)).resolves.not.toThrow();
  });

  it('treats a corrupted entry as a cache miss and calls fetcher', async () => {
    store.set('cache:corrupt', 'not-valid-json{{{');
    const fetcher = jest.fn().mockResolvedValue({ id: 2 });
    const result = await withCache('corrupt', 60, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: 2 });
  });

  it('deletes the corrupted key from Redis', async () => {
    store.set('cache:stale', '{broken');
    const fetcher = jest.fn().mockResolvedValue('fresh');
    await withCache('stale', 60, fetcher);
    // Allow the fire-and-forget unlink to complete
    await Promise.resolve();
    expect(mockRedis.unlink).toHaveBeenCalledWith('cache:stale');
  });

  it('logs a warning when a corrupted entry is encountered', async () => {
    store.set('cache:warn-key', 'definitely not json');
    const fetcher = jest.fn().mockResolvedValue(null);
    await withCache('warn-key', 60, fetcher);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cache entry could not be parsed'),
      expect.objectContaining({ cacheKey: 'cache:warn-key' }),
    );
  });

  it('returns fresh fetcher value after recovering from a corrupted entry', async () => {
    store.set('cache:recover', '}{invalid');
    const fetcher = jest.fn().mockResolvedValue({ name: 'Alice' });
    const result = await withCache('recover', 60, fetcher);
    expect(result).toEqual({ name: 'Alice' });
  });

  it('caches the fresh value after recovering, so the next call is a hit', async () => {
    store.set('cache:recache', '}{invalid');
    const fetcher = jest.fn().mockResolvedValue({ ok: true });
    await withCache('recache', 60, fetcher);
    // flush fire-and-forget set
    await Promise.resolve();

    // Now the store should have the fresh JSON value
    const second = await withCache('recache', 60, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ ok: true });
  });

  it('does not treat a valid JSON null as corrupted (sentinel path)', async () => {
    // JSON.stringify(SENTINEL) is '"__NULL__"' — a valid JSON string.
    // This must never be mistaken for a corrupted entry.
    store.set('cache:sentinel-check', JSON.stringify(SENTINEL));
    const fetcher = jest.fn();
    const result = await withCache('sentinel-check', 60, fetcher);
    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('does not affect normal (valid JSON) cache hits', async () => {
    store.set('cache:normal', JSON.stringify({ x: 42 }));
    const fetcher = jest.fn();
    const result = await withCache('normal', 60, fetcher);
    expect(result).toEqual({ x: 42 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockRedis.unlink).not.toHaveBeenCalledWith('cache:normal');
  });
});
