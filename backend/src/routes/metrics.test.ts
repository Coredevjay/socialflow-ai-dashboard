import express from 'express';
import request from 'supertest';
import metricsRouter from './metrics';

// OAuth callback CSRF state handling (issue #1738)
const mockRedisStore = new Map<string, string>();

jest.mock('../lib/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (key: string) => mockRedisStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      mockRedisStore.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => {
      const existed = mockRedisStore.delete(key);
      return existed ? 1 : 0;
    }),
  },
}));

const mockExchangeCode = jest.fn(async () => ({ accessToken: 'access-token' }));

jest.mock('../services/facebookService', () => ({
  exchangeCodeForToken: (...args: any[]) => mockExchangeCode(...args),
}));
jest.mock('../services/linkedinService', () => ({
  exchangeCodeForToken: (...args: any[]) => mockExchangeCode(...args),
}));
jest.mock('../services/tiktokService', () => ({
  exchangeCodeForToken: (...args: any[]) => mockExchangeCode(...args),
}));
jest.mock('../services/youtubeService', () => ({
  exchangeCodeForToken: (...args: any[]) => mockExchangeCode(...args),
}));

import facebookRouter from './facebook';
import linkedinRouter from './linkedin';
import tiktokRouter from './tiktok';
import youtubeRouter from './youtube';

const providers = [
  { name: 'facebook', router: facebookRouter },
  { name: 'linkedin', router: linkedinRouter },
  { name: 'tiktok', router: tiktokRouter },
  { name: 'youtube', router: youtubeRouter },
];

function makeProviderApp(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

function stateKey(provider: string, state: string) {
  return `oauth:state:${provider}:${state}`;
}

beforeEach(() => {
  mockRedisStore.clear();
  mockExchangeCode.mockClear();
});

describe.each(providers)('$name OAuth callback state validation', ({ name, router }) => {
  test('missing state returns 400', async () => {
    const app = makeProviderApp(router);
    const res = await request(app).get('/callback').query({ code: 'abc' });
    expect(res.status).toBe(400);
    expect(mockExchangeCode).not.toHaveBeenCalled();
  });

  test('unknown state returns 400', async () => {
    const app = makeProviderApp(router);
    const res = await request(app)
      .get('/callback')
      .query({ code: 'abc', state: 'never-issued-state' });
    expect(res.status).toBe(400);
    expect(mockExchangeCode).not.toHaveBeenCalled();
  });

  test('replayed state returns 400 on second use', async () => {
    const app = makeProviderApp(router);
    const state = `valid-${name}-state`;
    mockRedisStore.set(stateKey(name, state), 'user-1');

    const first = await request(app).get('/callback').query({ code: 'abc', state });
    expect(first.status).not.toBe(400);
    expect(mockExchangeCode).toHaveBeenCalledTimes(1);

    const replay = await request(app).get('/callback').query({ code: 'abc', state });
    expect(replay.status).toBe(400);
    expect(mockExchangeCode).toHaveBeenCalledTimes(1);
  });

  test('expired state (key absent) returns 400', async () => {
    const app = makeProviderApp(router);
    const state = `expired-${name}-state`;
    // Simulate TTL expiry: the key was never present / already evicted.
    mockRedisStore.delete(stateKey(name, state));

    const res = await request(app).get('/callback').query({ code: 'abc', state });
    expect(res.status).toBe(400);
    expect(mockExchangeCode).not.toHaveBeenCalled();
  });

  test('valid state resolves userId and proceeds to token exchange', async () => {
    const app = makeProviderApp(router);
    const state = `good-${name}-state`;
    mockRedisStore.set(stateKey(name, state), 'user-42');

    const res = await request(app).get('/callback').query({ code: 'abc', state });
    expect(res.status).not.toBe(400);
    expect(mockExchangeCode).toHaveBeenCalledTimes(1);
    expect(mockRedisStore.has(stateKey(name, state))).toBe(false);
  });
});

jest.mock('../queues/queueManager', () => ({
  queueManager: {
    refreshQueueMetrics: jest.fn(),
  },
}));

jest.mock('../lib/metrics', () => ({
  register: {
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
    metrics: jest.fn(async () => 'up 1\n'),
  },
}));

function makeApp(token?: string) {
  if (token === undefined) {
    delete process.env.METRICS_TOKEN;
  } else {
    process.env.METRICS_TOKEN = token;
  }

  const app = express();
  app.use('/metrics', metricsRouter);
  return app;
}

afterEach(() => {
  delete process.env.METRICS_TOKEN;
});

test('returns 401 with no Authorization header', async () => {
  const app = makeApp('supersecrettoken1234567890abcdef');
  await request(app).get('/metrics').expect(401);
});

test('returns 401 with wrong token', async () => {
  const app = makeApp('supersecrettoken1234567890abcdef');
  await request(app).get('/metrics').set('Authorization', 'Bearer wrongtoken').expect(401);
});

test('returns 200 with correct token', async () => {
  const token = 'supersecrettoken1234567890abcdef';
  const app = makeApp(token);
  const res = await request(app).get('/metrics').set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/plain/);
});

test('returns 503 when METRICS_TOKEN is not set', async () => {
  const app = makeApp();
  await request(app).get('/metrics').expect(503);
});
