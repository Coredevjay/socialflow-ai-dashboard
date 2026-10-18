/**
 * Standalone worker process entry point.
 *
 * Run by the socialflow-worker container (Dockerfile.worker).
 * The API server (server.ts) no longer starts these workers, so they
 * scale independently via the worker Kubernetes Deployment.
 */
import '../tracing'; // must be first — patches BullMQ and Prisma before they load
import http from 'http';
import { Worker } from 'bullmq';
import { startWorkers } from './index';
import { closeRedisClient } from '../queues/queueManager';
import { createLogger } from '../lib/logger';

const logger = createLogger('worker-standalone');

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 3002);
const REDIS_PING_TIMEOUT_MS = 2000;

const { ai, social } = startWorkers();

/**
 * Resolves true when the worker's Redis connection is ready and answers PING.
 * ioredis queues commands while disconnected, so the status check fails fast
 * instead of waiting for the ping timeout.
 */
async function isQueueConnectionHealthy(worker: Worker): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const client = await worker.client;
    if (client.status !== 'ready') return false;
    await Promise.race([
      client.ping(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis PING timed out')), REDIS_PING_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const healthServer = http.createServer((req, res) => {
  const send = (statusCode: number, body: Record<string, unknown>): void => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // Liveness: this handler only runs if the event loop is not blocked
  if (req.url === '/health/live') {
    send(200, { status: 'ok' });
    return;
  }

  if (req.url === '/health/ready') {
    void (async () => {
      const [aiQueue, socialQueue] = await Promise.all([
        isQueueConnectionHealthy(ai),
        isQueueConnectionHealthy(social),
      ]);
      const running = ai.isRunning() && social.isRunning();
      const ready = aiQueue && socialQueue && running;
      send(ready ? 200 : 503, {
        status: ready ? 'ok' : 'unavailable',
        aiQueue,
        socialQueue,
        running,
      });
    })();
    return;
  }

  send(404, { status: 'not_found' });
});

healthServer.listen(HEALTH_PORT, () => {
  logger.info(`Health server listening on port ${HEALTH_PORT}`);
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info(`Received ${signal}. Shutting down workers...`);
  try {
    await Promise.all([ai.close(), social.close()]);
    await closeRedisClient();
    healthServer.close();
    logger.info('Workers shut down cleanly');
    process.exit(0);
  } catch (err) {
    logger.error('Error during worker shutdown', { error: (err as Error).message });
    process.exit(1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
