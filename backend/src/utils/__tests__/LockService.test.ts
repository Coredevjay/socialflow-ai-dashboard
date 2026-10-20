import { LockService } from '../LockService';
import { Redis } from 'ioredis';

// Mock ioredis
jest.mock('ioredis');

describe('LockService', () => {
  let lockService: LockService;
  let mockRedis: jest.Mocked<Redis>;

  beforeEach(() => {
    mockRedis = {
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      eval: jest.fn(),
      pexpire: jest.fn(),
    } as unknown as jest.Mocked<Redis>;

    lockService = new LockService(mockRedis);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('acquireLock', () => {
    it('should acquire a lock successfully', async () => {
      mockRedis.set.mockResolvedValue('OK');

      const result = await lockService.acquireLock('test-key', 'test-value', 1000);

      expect(result).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith('test-key', 'test-value', 'PX', 1000, 'NX');
    });

    it('should fail to acquire a lock if already held', async () => {
      mockRedis.set.mockResolvedValue(null);

      const result = await lockService.acquireLock('test-key', 'test-value', 1000);

      expect(result).toBe(false);
    });
  });

  describe('releaseLock', () => {
    it('should release a lock successfully', async () => {
      mockRedis.eval.mockResolvedValue(1);

      const result = await lockService.releaseLock('test-key', 'test-value');

      expect(result).toBe(true);
      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('should fail to release a lock if not held', async () => {
      mockRedis.eval.mockResolvedValue(0);

      const result = await lockService.releaseLock('test-key', 'test-value');

      expect(result).toBe(false);
    });
  });

  describe('extendLock', () => {
    it('should extend a lock successfully', async () => {
      mockRedis.eval.mockResolvedValue(1);

      const result = await lockService.extendLock('test-key', 'test-value', 1000);

      expect(result).toBe(true);
      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('should fail to extend a lock if not held', async () => {
      mockRedis.eval.mockResolvedValue(0);

      const result = await lockService.extendLock('test-key', 'test-value', 1000);

      expect(result).toBe(false);
    });
  });

  describe('withLock', () => {
    it('should execute the callback while holding the lock', async () => {
      mockRedis.set.mockResolvedValue('OK');
      mockRedis.eval.mockResolvedValue(1);

      const callback = jest.fn().mockResolvedValue('result');

      const result = await lockService.withLock('test-key', callback, { ttl: 1000 });

      expect(result).toBe('result');
      expect(callback).toHaveBeenCalled();
      expect(mockRedis.set).toHaveBeenCalled();
      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('should throw an error if the lock cannot be acquired', async () => {
      mockRedis.set.mockResolvedValue(null);

      const callback = jest.fn();

      await expect(lockService.withLock('test-key', callback, { ttl: 1000 })).rejects.toThrow(
        'Failed to acquire lock'
      );

      expect(callback).not.toHaveBeenCalled();
    });

    it('should release the lock even if the callback throws', async () => {
      mockRedis.set.mockResolvedValue('OK');
      mockRedis.eval.mockResolvedValue(1);

      const callback = jest.fn().mockRejectedValue(new Error('callback error'));

      await expect(lockService.withLock('test-key', callback, { ttl: 1000 })).rejects.toThrow(
        'callback error'
      );

      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('should not start a new extension while a previous extension is still pending', async () => {
      jest.useFakeTimers();

      mockRedis.set.mockResolvedValue('OK');

      // Track concurrent in-flight extend calls.
      let inFlight = 0;
      let maxInFlight = 0;
      let extendCalls = 0;

      // First extend resolves slowly; subsequent ones resolve immediately.
      mockRedis.eval.mockImplementation(() => {
        extendCalls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);

        const delay = extendCalls === 1 ? 500 : 0;
        return new Promise<number>((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve(1);
          }, delay);
        });
      });

      let releaseCallback: () => void = () => {};
      const callback = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseCallback = resolve;
          })
      );

      const lockPromise = lockService.withLock('test-key', callback, {
        ttl: 1000,
        extendInterval: 100,
      });

      // Let the lock be acquired and the callback start.
      await Promise.resolve();
      await Promise.resolve();

      // Advance past several intervals while the first extend is still pending.
      await jest.advanceTimersByTimeAsync(1000);

      // The slow first extend must not have been overlapped by another.
      expect(maxInFlight).toBe(1);

      // Finish the callback and let the lock release.
      releaseCallback();
      await jest.advanceTimersByTimeAsync(1000);
      await lockPromise;

      // No timers should remain scheduled after release.
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
