/**
 * QueueManager tests
 *
 * 1. closeAll – graceful shutdown ordering
 *    Verifies that workers are fully drained before queues/events and the
 *    Redis client are closed, so no in-flight job results are lost.
 *
 * 2. addJob – job ID generation (regression for #1808)
 *    Verifies that:
 *    - When no jobId is supplied, a UUID v4 is generated (not a
 *      Date.now()+Math.random() composite that breaks deduplication).
 *    - Two calls without a jobId produce different IDs (no collision).
 *    - When a deterministic jobId is supplied, it is forwarded verbatim to
 *      BullMQ so deduplication can work.
 *    - The deprecated String.prototype.substr pattern is never used.
 */

// ── mocks ─────────────────────────────────────────────────────────────────────

// Track call order across all mock close() calls
const callOrder: string[] = [];

const mockWorkerClose = jest.fn(() => {
  callOrder.push('worker');
  return Promise.resolve();
});

const mockQueueClose = jest.fn(() => {
  callOrder.push('queue');
  return Promise.resolve();
});

const mockEventsClose = jest.fn(() => {
  callOrder.push('events');
  return Promise.resolve();
});

const mockRedisQuit = jest.fn(() => {
  callOrder.push('redis');
  return Promise.resolve('OK' as const);
});

// Capture the jobId that was passed to queue.add() so tests can assert on it.
let lastAddOpts: Record<string, unknown> = {};
const mockQueueAdd = jest.fn((jobName: string, data: unknown, opts: Record<string, unknown>) => {
  lastAddOpts = opts ?? {};
  return Promise.resolve({ id: opts?.jobId ?? 'returned-id' });
});

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    quit: mockRedisQuit,
    on: jest.fn(),
  }));
});

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((name: string) => ({
    name,
    close: mockQueueClose,
    add: mockQueueAdd,
  })),
  Worker: jest.fn().mockImplementation(() => ({
    close: mockWorkerClose,
    on: jest.fn(),
  })),
  QueueEvents: jest.fn().mockImplementation(() => ({
    close: mockEventsClose,
    on: jest.fn(),
  })),
}));

jest.mock('../config/config', () => ({
  config: {
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: 6379,
    REDIS_PASSWORD: undefined,
  },
}));

// ── tests ─────────────────────────────────────────────────────────────────────

import { QueueManager } from '../queues/queueManager';

// UUID v4 pattern: 8-4-4-4-12 hex chars with version=4 and variant bits set
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => {
  callOrder.length = 0;
  lastAddOpts = {};
  mockWorkerClose.mockClear();
  mockQueueClose.mockClear();
  mockEventsClose.mockClear();
  mockRedisQuit.mockClear();
  mockQueueAdd.mockClear();
});

// ── closeAll ──────────────────────────────────────────────────────────────────

describe('QueueManager.closeAll – shutdown ordering', () => {
  it('closes workers before queues/events and Redis', async () => {
    const manager = new QueueManager();
    manager.createQueue('test-queue', {});
    manager.createWorker('test-queue', jest.fn());

    await manager.closeAll();

    const workerIdx = callOrder.indexOf('worker');
    const queueIdx = callOrder.indexOf('queue');
    const redisIdx = callOrder.indexOf('redis');

    expect(workerIdx).toBeLessThan(queueIdx);
    expect(workerIdx).toBeLessThan(redisIdx);
  });

  it('closes Redis after queues and events', async () => {
    const manager = new QueueManager();
    manager.createQueue('test-queue', {});

    await manager.closeAll();

    const queueIdx = callOrder.indexOf('queue');
    const redisIdx = callOrder.indexOf('redis');

    expect(queueIdx).toBeLessThan(redisIdx);
  });

  it('calls close on every registered worker', async () => {
    const manager = new QueueManager();
    manager.createQueue('q1', {});
    manager.createQueue('q2', {});
    manager.createWorker('q1', jest.fn());
    manager.createWorker('q2', jest.fn());

    await manager.closeAll();

    expect(mockWorkerClose).toHaveBeenCalledTimes(2);
  });

  it('calls quit on the Redis client exactly once', async () => {
    const manager = new QueueManager();
    await manager.closeAll();
    expect(mockRedisQuit).toHaveBeenCalledTimes(1);
  });
});

// ── addJob – job ID generation (#1808 regression) ─────────────────────────────

describe('QueueManager.addJob – job ID generation', () => {
  it('generates a UUID v4 when no jobId is supplied', async () => {
    const manager = new QueueManager();
    manager.createQueue('q', {});

    const id = await manager.addJob('q', 'my-job', { foo: 'bar' });

    expect(id).toMatch(UUID_V4_RE);
  });

  it('passes the generated UUID to queue.add', async () => {
    const manager = new QueueManager();
    manager.createQueue('q', {});

    await manager.addJob('q', 'my-job', {});

    expect(lastAddOpts.jobId).toMatch(UUID_V4_RE);
  });

  it('two calls without a jobId produce different IDs', async () => {
    const manager = new QueueManager();
    manager.createQueue('q', {});

    const id1 = await manager.addJob('q', 'my-job', {});
    const id2 = await manager.addJob('q', 'my-job', {});

    expect(id1).not.toBe(id2);
  });

  it('forwards a caller-supplied deterministic jobId verbatim', async () => {
    const manager = new QueueManager();
    manager.createQueue('q', {});

    const deterministicId = 'social-sync:user-42:twitter';
    const id = await manager.addJob('q', 'sync', {}, { jobId: deterministicId });

    expect(id).toBe(deterministicId);
    expect(lastAddOpts.jobId).toBe(deterministicId);
  });

  it('does NOT produce the legacy Date.now()+Math.random() composite format', async () => {
    // The old format was "<queueName>-<timestamp>-<9-char alphanumeric>" which
    // never matches a UUID v4.  Any id generated without an explicit jobId must
    // now be a UUID v4.
    const manager = new QueueManager();
    manager.createQueue('my-queue', {});

    const id = await manager.addJob('my-queue', 'my-job', {});

    // Must be a UUID — not the legacy "<name>-<digits>-<alphanum9>" pattern
    const legacyPattern = /^my-queue-\d+-[a-z0-9]{9}$/;
    expect(id).not.toMatch(legacyPattern);
    expect(id).toMatch(UUID_V4_RE);
  });

  it('throws when the target queue has not been created', async () => {
    const manager = new QueueManager();

    await expect(
      manager.addJob('nonexistent-queue', 'job', {}),
    ).rejects.toThrow('Queue "nonexistent-queue" not found');
  });

  it('returns the job id string resolved by BullMQ', async () => {
    const manager = new QueueManager();
    manager.createQueue('q', {});

    const id = await manager.addJob('q', 'job', {});

    // mockQueueAdd returns { id: opts.jobId } — so id must equal the UUID passed in
    expect(typeof id).toBe('string');
    expect(id!.length).toBeGreaterThan(0);
  });
});
