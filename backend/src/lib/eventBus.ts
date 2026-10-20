/**
 * Event Bus
 *
 * Publish/subscribe bus for job progress events consumed by the SSE endpoint
 * and SocketService.
 *
 * Producers (BullMQ workers) and consumers (API pods) run in separate
 * processes, so once `attachRedis` has been called the bus routes events
 * through Redis pub/sub: `emitJobProgress` assigns a per-user monotonically
 * increasing `seq`, stores the event in a short replay buffer and publishes
 * it; every process that called `attachRedis` with a subscriber re-emits it
 * locally. Without Redis the bus falls back to in-process delivery with a
 * local sequence/buffer (tests, single-process dev).
 */
import { EventEmitter } from 'events';
import type Redis from 'ioredis';

export type JobType = 'video_transcoding' | 'ai_generation';
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface JobProgressEvent {
  jobId: string;
  userId: string;
  type: JobType;
  status: JobStatus;
  progress: number; // 0-100
  message?: string;
  error?: string;
  meta?: Record<string, unknown>;
  /** Per-user monotonically increasing sequence, used as the SSE event id. */
  seq?: number;
}

export const JOB_PROGRESS_CHANNEL = 'job-progress';
const REPLAY_BUFFER_SIZE = 100;
const REPLAY_BUFFER_TTL_S = 300;

const seqKey = (userId: string) => `sse:seq:${userId}`;
const bufKey = (userId: string) => `sse:buf:${userId}`;

class EventBus extends EventEmitter {
  private pub: Redis | null = null;
  private sub: Redis | null = null;
  private localSeq = new Map<string, number>();
  private localBuf = new Map<string, JobProgressEvent[]>();

  constructor() {
    super();
    this.setMaxListeners(200); // support many concurrent SSE connections
  }

  /**
   * Bridge the bus through Redis. `pub` is required to publish from any
   * process; pass `sub` (a dedicated connection) in processes that serve SSE.
   */
  async attachRedis(pub: Redis, sub?: Redis): Promise<void> {
    this.pub = pub;
    if (!sub) return;
    this.sub = sub;
    sub.on('message', (channel: string, message: string) => {
      if (channel !== JOB_PROGRESS_CHANNEL) return;
      try {
        this.dispatch(JSON.parse(message) as JobProgressEvent);
      } catch {
        // ignore malformed messages
      }
    });
    await sub.subscribe(JOB_PROGRESS_CHANNEL);
  }

  async detachRedis(): Promise<void> {
    if (this.sub) await this.sub.unsubscribe(JOB_PROGRESS_CHANNEL).catch(() => undefined);
    this.pub = null;
    this.sub = null;
  }

  emitJobProgress(event: JobProgressEvent): void {
    if (!this.pub) {
      const seq = (this.localSeq.get(event.userId) ?? 0) + 1;
      this.localSeq.set(event.userId, seq);
      const stamped = { ...event, seq };
      const buf = this.localBuf.get(event.userId) ?? [];
      buf.push(stamped);
      if (buf.length > REPLAY_BUFFER_SIZE) buf.shift();
      this.localBuf.set(event.userId, buf);
      this.dispatch(stamped);
      return;
    }
    const pub = this.pub;
    void (async () => {
      try {
        const seq = await pub.incr(seqKey(event.userId));
        const payload = JSON.stringify({ ...event, seq });
        await pub
          .multi()
          .rpush(bufKey(event.userId), payload)
          .ltrim(bufKey(event.userId), -REPLAY_BUFFER_SIZE, -1)
          .expire(bufKey(event.userId), REPLAY_BUFFER_TTL_S)
          .expire(seqKey(event.userId), REPLAY_BUFFER_TTL_S * 12)
          .publish(JOB_PROGRESS_CHANNEL, payload)
          .exec();
      } catch (err) {
        console.error('Failed to publish job progress event:', err);
      }
    })();
  }

  /** Events for `userId` with seq greater than `lastSeq` (for Last-Event-ID replay). */
  async getMissedEvents(userId: string, lastSeq: number): Promise<JobProgressEvent[]> {
    let events: JobProgressEvent[];
    if (this.pub) {
      const raw = await this.pub.lrange(bufKey(userId), 0, -1);
      events = raw.map((r) => JSON.parse(r) as JobProgressEvent);
    } else {
      events = this.localBuf.get(userId) ?? [];
    }
    return events.filter((e) => (e.seq ?? 0) > lastSeq);
  }

  private dispatch(event: JobProgressEvent): void {
    this.emit(`job:${event.userId}`, event);
    this.emit('job:*', event); // wildcard for admin/monitoring
  }

  onUserJob(userId: string, listener: (event: JobProgressEvent) => void): void {
    this.on(`job:${userId}`, listener);
  }

  offUserJob(userId: string, listener: (event: JobProgressEvent) => void): void {
    this.off(`job:${userId}`, listener);
  }

  reset(): void {
    this.removeAllListeners();
    this.localSeq.clear();
    this.localBuf.clear();
  }
}

export const eventBus = new EventBus();

export const resetEventBus = (): void => {
  eventBus.reset();
};
