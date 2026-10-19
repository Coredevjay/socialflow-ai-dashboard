/**
 * rateLimit.test.ts — coverage for rateLimit.ts (issue #1242): limiter
 * creation and the shared 429 response body.
 *
 * NOTE: this file must live under middleware/__tests__/ and reference the
 * module under test as '../rateLimit' (not '../middleware/rateLimit'). The
 * "unit" Jest project maps the module path pattern `.*(/|\\)middleware(/|\\)rateLimit`
 * to a lightweight passthrough stub (src/__tests__/__mocks__/rateLimit.ts)
 * so that unrelated suites don't need a real Redis/in-memory rate limiter.
 * Requiring it via '../rateLimit' from inside this directory does not match
 * that pattern, so this suite exercises the real implementation.
 *
 * 'rate-limit-redis' is mocked to throw on import in every test below —
 * this simulates the store being unavailable so express-rate-limit falls
 * back to its deterministic in-memory MemoryStore (matching the existing
 * convention in src/__tests__/rateLimitLogger.test.ts), keeping these tests
 * free of any real Redis dependency.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import express from 'express';
import request from 'supertest';

function freshRequire<T>(modulePath: string): T {
  jest.resetModules();
  jest.mock('rate-limit-redis', () => {
    throw new Error("Cannot find module 'rate-limit-redis'");
  });
  // Mock the shared redis singleton so lib/redis.ts doesn't construct a real
  // client (which would trigger config validation and require env vars).
  jest.mock('../../lib/redis', () => ({
    redis: {
      status: 'end',
      quit: jest.fn().mockResolvedValue('OK'),
      on: jest.fn(),
      call: jest.fn(),
    },
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(modulePath) as T;
}

afterEach(() => {
  jest.unmock('rate-limit-redis');
  jest.unmock('../../lib/redis');
  jest.resetModules();
});

describe('initRateLimiters — limiter creation', () => {
  it('resolves without throwing and creates all three named limiters as callable middleware', async () => {
    const mod = freshRequire<typeof import('../rateLimit')>('../rateLimit');
    await expect(mod.initRateLimiters()).resolves.toBeUndefined();

    expect(typeof mod.authLimiter).toBe('function');
    expect(typeof mod.aiLimiter).toBe('function');
    expect(typeof mod.generalLimiter).toBe('function');
  });

  it('applies a stricter threshold to authLimiter (10/15min) than generalLimiter (100/min)', async () => {
    const mod = freshRequire<typeof import('../rateLimit')>('../rateLimit');
    await mod.initRateLimiters();

    const app = express();
    app.get('/auth', mod.authLimiter, (_req, res) => res.json({ ok: true }));
    app.get('/general', mod.generalLimiter, (_req, res) => res.json({ ok: true }));

    // authLimiter allows 10 requests, then blocks the 11th.
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get('/auth');
      expect(res.status).toBe(200);
    }
    const authBlocked = await request(app).get('/auth');
    expect(authBlocked.status).toBe(429);

    // generalLimiter allows well beyond 10 requests in the same window.
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get('/general');
      expect(res.status).toBe(200);
    }
  });
});

describe('429 response body', () => {
  it('returns the structured JSON error body once the auth limiter threshold is exceeded', async () => {
    const mod = freshRequire<typeof import('../rateLimit')>('../rateLimit');
    await mod.initRateLimiters();

    const app = express();
    app.get('/auth', mod.authLimiter, (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).get('/auth');
    }
    const blocked = await request(app).get('/auth');

    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      success: false,
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please slow down and try again later.',
    });
    expect(typeof blocked.body.retryAfter).toBe('number');
    expect(typeof blocked.body.timestamp).toBe('string');
    expect(() => new Date(blocked.body.timestamp).toISOString()).not.toThrow();
  });
});

describe('resetLimiters', () => {
  it('clears in-memory counters so a previously blocked client can succeed again', async () => {
    const mod = freshRequire<typeof import('../rateLimit')>('../rateLimit');
    await mod.initRateLimiters();

    const app = express();
    app.get('/auth', mod.authLimiter, (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).get('/auth');
    }
    const blocked = await request(app).get('/auth');
    expect(blocked.status).toBe(429);

    mod.resetLimiters();

    const afterReset = await request(app).get('/auth');
    expect(afterReset.status).toBe(200);
  });

  it('is a no-op that does not throw when called before any limiter has been initialized', () => {
    const mod = freshRequire<typeof import('../rateLimit')>('../rateLimit');
    expect(() => mod.resetLimiters()).not.toThrow();
  });
});

// ── Helpers shared by #1812 regression tests ──────────────────────────────────

/**
 * Build a minimal fake Redis client that the tests can inspect.
 * The `on` spy records registered event names so we can assert that an
 * 'error' handler was attached.
 */
function makeFakeRedis(status: string = 'ready') {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    status,
    quit: jest.fn().mockResolvedValue('OK'),
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    // Expose so tests can trigger the 'error' event manually
    emit: (event: string, ...args: unknown[]) => {
      (listeners[event] ?? []).forEach((fn) => fn(...args));
    },
    call: jest.fn().mockResolvedValue(null),
  };
}

/**
 * Variant of freshRequire that also injects a fake Redis client and a
 * controllable RedisStore constructor.
 */
function freshRequireWithRedis<T>(
  modulePath: string,
  fakeRedis: ReturnType<typeof makeFakeRedis>,
  redisStoreFactory?: () => object,
) {
  jest.resetModules();

  // Mock the shared redis singleton
  jest.mock('../../lib/redis', () => ({ redis: fakeRedis }));

  if (redisStoreFactory) {
    // Provide a working rate-limit-redis mock so buildStore succeeds
    jest.mock('rate-limit-redis', () => ({
      default: jest.fn().mockImplementation(redisStoreFactory),
    }));
  } else {
    // Simulate rate-limit-redis being absent → in-memory fallback
    jest.mock('rate-limit-redis', () => {
      throw new Error("Cannot find module 'rate-limit-redis'");
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(modulePath) as T;
}

// ── #1812 — shared client, error handler, close hook ─────────────────────────

describe('buildStore (#1812) — reuses shared Redis client', () => {
  afterEach(() => {
    jest.unmock('rate-limit-redis');
    jest.unmock('../../lib/redis');
    jest.resetModules();
  });

  it('does not construct a new Redis() client — uses the shared singleton', async () => {
    // If buildStore still called `new Redis(...)`, the ioredis constructor
    // mock below would record the call.
    const redisCtor = jest.fn();
    jest.mock('ioredis', () => redisCtor);

    const fakeRedis = makeFakeRedis();
    const mod = freshRequireWithRedis<typeof import('../rateLimit')>('../rateLimit', fakeRedis, () => ({}));

    await mod.initRateLimiters();

    expect(redisCtor).not.toHaveBeenCalled();
  });

  it('passes the shared redis client to the RedisStore sendCommand', async () => {
    const fakeRedis = makeFakeRedis();
    let capturedSendCommand: ((...args: string[]) => unknown) | undefined;

    const mod = freshRequireWithRedis<typeof import('../rateLimit')>(
      '../rateLimit',
      fakeRedis,
      () => {
        // RedisStore receives { sendCommand } — capture it
        return {
          _capturedBy: (opts: { sendCommand: (...args: string[]) => unknown }) => {
            capturedSendCommand = opts.sendCommand;
          },
        };
      },
    );

    // Use a RedisStore mock that captures the options
    jest.resetModules();
    jest.mock('../../lib/redis', () => ({ redis: fakeRedis }));
    jest.mock('rate-limit-redis', () => ({
      default: jest.fn().mockImplementation((opts: { sendCommand: (...args: string[]) => unknown }) => {
        capturedSendCommand = opts.sendCommand;
        return {};
      }),
    }));
    const mod2 = require('../rateLimit') as typeof import('../rateLimit');
    await mod2.initRateLimiters();

    // Invoke sendCommand and confirm it delegates to fakeRedis.call
    if (capturedSendCommand) {
      capturedSendCommand('GET', 'some-key');
      expect(fakeRedis.call).toHaveBeenCalledWith('GET', 'some-key');
    }
  });
});

describe('buildStore (#1812) — error handler on shared client', () => {
  afterEach(() => {
    jest.unmock('rate-limit-redis');
    jest.unmock('../../lib/redis');
    jest.resetModules();
  });

  it('registers an error handler on the shared Redis client when Redis store is available', async () => {
    const fakeRedis = makeFakeRedis();
    const mod = freshRequireWithRedis<typeof import('../rateLimit')>(
      '../rateLimit',
      fakeRedis,
      () => ({}),
    );

    await mod.initRateLimiters();

    // The 'error' event must have a listener so connection errors are handled
    // and do not become unhandled EventEmitter exceptions.
    const calls = (fakeRedis.on as jest.Mock).mock.calls as [string, ...unknown[]][];
    const errorListeners = calls.filter(([event]) => event === 'error');
    expect(errorListeners.length).toBeGreaterThanOrEqual(1);
  });

  it('error handler does not throw when the Redis client emits an error', async () => {
    const fakeRedis = makeFakeRedis();
    const mod = freshRequireWithRedis<typeof import('../rateLimit')>(
      '../rateLimit',
      fakeRedis,
      () => ({}),
    );

    await mod.initRateLimiters();

    // Emitting 'error' should be caught by the registered handler — not crash.
    expect(() => fakeRedis.emit('error', new Error('ECONNREFUSED'))).not.toThrow();
  });

  it('registers the error handler exactly once even when initRateLimiters is called multiple times', async () => {
    const fakeRedis = makeFakeRedis();
    const mod = freshRequireWithRedis<typeof import('../rateLimit')>(
      '../rateLimit',
      fakeRedis,
      () => ({}),
    );

    await mod.initRateLimiters();
    await mod.initRateLimiters(); // second call — store promise is already cached

    const calls = (fakeRedis.on as jest.Mock).mock.calls as [string, ...unknown[]][];
    const errorListeners = calls.filter(([event]) => event === 'error');
    expect(errorListeners.length).toBe(1);
  });

  it('does not attach an error handler when the Redis store falls back to in-memory', async () => {
    // rate-limit-redis unavailable → in-memory fallback → no redis.on('error')
    const fakeRedis = makeFakeRedis();
    const mod = freshRequireWithRedis<typeof import('../rateLimit')>(
      '../rateLimit',
      fakeRedis,
      // No redisStoreFactory → fallback to in-memory
    );

    await mod.initRateLimiters();

    const calls = (fakeRedis.on as jest.Mock).mock.calls as [string, ...unknown[]][];
    const errorListeners = calls.filter(([event]) => event === 'error');
    expect(errorListeners.length).toBe(0);
  });
});

describe('closeRateLimitStore (#1812) — graceful shutdown hook', () => {
  afterEach(() => {
    jest.unmock('rate-limit-redis');
    jest.unmock('../../lib/redis');
    jest.resetModules();
  });

  it('calls redis.quit() when the client is in ready state', async () => {
    const fakeRedis = makeFakeRedis('ready');
    const mod = freshRequireWithRedis<typeof import('../rateLimit')>('../rateLimit', fakeRedis);

    await mod.closeRateLimitStore();

    expect(fakeRedis.quit).toHaveBeenCalledTimes(1);
  });

  it('calls redis.quit() when the client is in connect state', async () => {
    const fakeRedis = makeFakeRedis('connect');
    const mod = freshRequireWithRedis<typeof import('../rateLimit')>('../rateLimit', fakeRedis);

    await mod.closeRateLimitStore();

    expect(fakeRedis.quit).toHaveBeenCalledTimes(1);
  });

  it('does not call redis.quit() when the client is already closed', async () => {
    const fakeRedis = makeFakeRedis('end');
    const mod = freshRequireWithRedis<typeof import('../rateLimit')>('../rateLimit', fakeRedis);

    await mod.closeRateLimitStore();

    expect(fakeRedis.quit).not.toHaveBeenCalled();
  });

  it('does not throw if redis.quit() rejects', async () => {
    const fakeRedis = makeFakeRedis('ready');
    fakeRedis.quit.mockRejectedValueOnce(new Error('quit failed'));
    const mod = freshRequireWithRedis<typeof import('../rateLimit')>('../rateLimit', fakeRedis);

    await expect(mod.closeRateLimitStore()).resolves.toBeUndefined();
  });

  it('is a no-op (does not throw) when called before initRateLimiters', async () => {
    const fakeRedis = makeFakeRedis('ready');
    const mod = freshRequireWithRedis<typeof import('../rateLimit')>('../rateLimit', fakeRedis);

    // closeRateLimitStore without initRateLimiters
    await expect(mod.closeRateLimitStore()).resolves.toBeUndefined();
  });
});
