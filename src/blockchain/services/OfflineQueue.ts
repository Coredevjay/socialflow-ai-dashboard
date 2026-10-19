/**
 * OfflineQueue - Persists pending transactions to Redis
 * Prevents loss of queued transactions on server restart
 */

interface QueuedTransaction {
  id: string;
  xdr: string;
  timestamp: number;
}

/**
 * The subset of the Redis client surface OfflineQueue uses. Satisfied by
 * ioredis and by the localStorage-backed browser store in browserQueueStore.ts.
 */
export interface OfflineQueueRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  hvals(key: string): Promise<string[]>;
  hdel(key: string, field: string): Promise<number>;
  hlen(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

/** Generates a collision-resistant, unpredictable transaction id. */
function generateTransactionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `tx_${crypto.randomUUID()}`;
  }
  // Fallback for insecure contexts where crypto.randomUUID is unavailable.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `tx_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class OfflineQueue {
  private readonly QUEUE_KEY = 'stellar:offline:queue';
  private readonly QUEUE_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
  private readonly MAX_QUEUE_SIZE: number;
  private redis: OfflineQueueRedis | undefined;
  private inMemoryQueue: QueuedTransaction[] = [];

  // Atomically checks the hash size against MAX_QUEUE_SIZE and, if there's
  // room, writes the entry — closing the check-then-push race between
  // concurrent callers. Returns 1 if the transaction was queued, 0 if full.
  private static readonly ENQUEUE_SCRIPT = `
    local key = KEYS[1]
    local maxSize = tonumber(ARGV[1])
    local field = ARGV[2]
    local value = ARGV[3]
    local ttl = tonumber(ARGV[4])
    if redis.call('HLEN', key) >= maxSize then
      return 0
    end
    redis.call('HSET', key, field, value)
    redis.call('EXPIRE', key, ttl)
    return 1
  `;

  constructor(redisClient?: OfflineQueueRedis, maxQueueSize = 1000) {
    this.redis = redisClient;
    this.MAX_QUEUE_SIZE = maxQueueSize;
    if (!this.redis) {
      console.warn('OfflineQueue: Redis client not provided, using in-memory storage only');
    }
  }

  /**
   * Queue a transaction for offline submission.
   * Throws if the queue has reached MAX_QUEUE_SIZE.
   */
  async queueTransaction(xdr: string): Promise<string> {
    const id = generateTransactionId();
    const transaction: QueuedTransaction = {
      id,
      xdr,
      timestamp: Date.now(),
    };

    if (this.redis) {
      try {
        const accepted = await this.redis.eval(
          OfflineQueue.ENQUEUE_SCRIPT,
          1,
          this.QUEUE_KEY,
          this.MAX_QUEUE_SIZE,
          id,
          JSON.stringify(transaction),
          this.QUEUE_TTL
        );
        if (!accepted) {
          throw new Error(`Offline queue is full (max ${this.MAX_QUEUE_SIZE} transactions)`);
        }
        this.inMemoryQueue.push(transaction);
        return id;
      } catch (error) {
        if (error instanceof Error && error.message.includes('full')) {
          throw error;
        }
        console.error('Failed to persist transaction to Redis:', error);
        // Fall through to in-memory storage below.
      }
    }

    // In-memory path (no Redis, or Redis unavailable): the check and push
    // below run with no `await` between them, so no other queueTransaction
    // call can interleave and observe a stale size.
    if (this.inMemoryQueue.length >= this.MAX_QUEUE_SIZE) {
      throw new Error(`Offline queue is full (max ${this.MAX_QUEUE_SIZE} transactions)`);
    }
    this.inMemoryQueue.push(transaction);
    return id;
  }

  /**
   * Get all queued transactions
   */
  async getQueuedTransactions(): Promise<QueuedTransaction[]> {
    if (this.redis) {
      try {
        const items = await this.redis.hvals(this.QUEUE_KEY);
        return items.map((item: string) => JSON.parse(item));
      } catch (error) {
        console.error('Failed to retrieve transactions from Redis:', error);
        return this.inMemoryQueue;
      }
    }
    return this.inMemoryQueue;
  }

  /**
   * Remove a transaction from the queue in O(1) via a direct hash field
   * delete, instead of scanning the full list to find a matching entry.
   */
  async removeTransaction(id: string): Promise<void> {
    // Remove from memory
    this.inMemoryQueue = this.inMemoryQueue.filter(tx => tx.id !== id);

    // Remove from Redis if available
    if (this.redis) {
      try {
        await this.redis.hdel(this.QUEUE_KEY, id);
      } catch (error) {
        console.error('Failed to remove transaction from Redis:', error);
      }
    }
  }

  /**
   * Clear all queued transactions
   */
  async clearQueue(): Promise<void> {
    this.inMemoryQueue = [];

    if (this.redis) {
      try {
        await this.redis.del(this.QUEUE_KEY);
      } catch (error) {
        console.error('Failed to clear Redis queue:', error);
      }
    }
  }

  /**
   * Get queue size
   */
  async getQueueSize(): Promise<number> {
    if (this.redis) {
      try {
        return await this.redis.hlen(this.QUEUE_KEY);
      } catch (error) {
        console.error('Failed to get queue size from Redis:', error);
        return this.inMemoryQueue.length;
      }
    }
    return this.inMemoryQueue.length;
  }

  /**
   * Restore queue from Redis on initialization
   */
  async restoreFromRedis(): Promise<void> {
    if (!this.redis) return;

    try {
      const items = await this.redis.hvals(this.QUEUE_KEY);
      this.inMemoryQueue = items.map((item: string) => JSON.parse(item));
      console.log(`Restored ${this.inMemoryQueue.length} transactions from Redis`);
    } catch (error) {
      console.error('Failed to restore queue from Redis:', error);
    }
  }
}
