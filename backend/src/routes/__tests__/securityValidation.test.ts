import express from 'express';
import request from 'supertest';

jest.mock('../../middleware/authenticate', () => ({
  authenticate: (req: any, res: any, next: any) => {
    if (!req.headers.authorization) return res.status(401).json({ message: 'Unauthorized' });
    req.user = { id: 'u1' };
    next();
  },
}));
jest.mock('../../middleware/authMiddleware', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../middleware/checkPermission', () => ({
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../config/runtime', () => ({ getConfiguredQueueNames: () => ['q1'] }));
jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

const getJobs = jest.fn().mockResolvedValue([]);
jest.mock('../../services/jobMonitor', () => ({
  jobMonitor: { getJobs: (...a: any[]) => getJobs(...a), getQueueNames: () => ['q1'] },
}));

const optimize = jest.fn().mockResolvedValue({
  buffer: Buffer.from('x'), format: 'webp', cacheKey: 'k', etag: '"e"',
});
jest.mock('../../services/ImageOptimizationService', () => ({
  ImageOptimizationService: {
    optimize: (...a: any[]) => optimize(...a),
    getCacheSize: jest.fn().mockResolvedValue(10),
  },
}));

const svc = {
  getStatus: () => ({ cachedKeys: ['CACHE_TTL', 'api_token'] }),
  get: (k: string) => `val-${k}`,
  set: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../../services/DynamicConfigService', () => ({
  ConfigKey: { CACHE_TTL: 'CACHE_TTL' },
  getDynamicConfigService: async () => svc,
}));

import configRouter from '../config';
import jobsRouter from '../jobs';
import imagesRouter from '../images';

const app = express();
app.use(express.json());
app.use('/api/config', configRouter);
app.use('/', jobsRouter);
app.use('/images', imagesRouter);
const auth = { Authorization: 'Bearer t' };

describe('config route (#1766)', () => {
  it('rejects unknown keys, bad type, mismatched value', async () => {
    expect((await request(app).put('/api/config/evil').send({ value: 'x' })).status).toBe(400);
    expect((await request(app).put('/api/config/CACHE_TTL').send({ value: 1, type: 'bogus' })).status).toBe(400);
    expect((await request(app).put('/api/config/CACHE_TTL').send({ value: 'abc', type: 'number' })).status).toBe(400);
    expect(svc.set).not.toHaveBeenCalled();
  });
  it('accepts valid update and redacts sensitive keys on GET', async () => {
    expect((await request(app).put('/api/config/CACHE_TTL').send({ value: 5, type: 'number' })).status).toBe(200);
    const res = await request(app).get('/api/config');
    expect(res.body.configs.CACHE_TTL).toBe('val-CACHE_TTL');
    expect(res.body.configs.api_token).toBe('[REDACTED]');
  });
});

describe('jobs route (#1767)', () => {
  beforeEach(() => getJobs.mockClear());
  it('clamps window and validates inputs', async () => {
    await request(app).get('/jobs/q1/jobs?end=1000000000');
    expect(getJobs).toHaveBeenCalledWith('q1', 'waiting', 0, 99);
    expect((await request(app).get('/jobs/q1/jobs?start=-5')).status).toBe(400);
    expect((await request(app).get('/jobs/q1/jobs?status=evil')).status).toBe(400);
    expect((await request(app).get('/jobs/nope/jobs')).status).toBe(404);
    expect((await request(app).get('/jobs/nope/failed')).status).toBe(404);
    expect((await request(app).get('/jobs/q1/failed?end=abc')).status).toBe(400);
  });
});

describe('images route (#1768, #1769)', () => {
  it('requires auth for proxy and cache size', async () => {
    expect((await request(app).get('/images/proxy?path=a.png')).status).toBe(401);
    expect((await request(app).get('/images/cache/size')).status).toBe(401);
    expect((await request(app).get('/images/cache/size').set(auth)).status).toBe(200);
  });
  it('rejects out-of-bounds resize params', async () => {
    for (const q of ['width=30000', 'height=-1', 'quality=0', 'quality=abc', 'format=gif']) {
      const res = await request(app).get(`/images/proxy?path=a.png&${q}`).set(auth);
      expect(res.status).toBe(400);
    }
    expect(optimize).not.toHaveBeenCalled();
  });
});
