import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/authenticate';
import { eventBus, JobProgressEvent } from '../lib/eventBus';
import { createLogger } from '../lib/logger';
import { verifyAccessToken } from '../lib/jwt';
import { sseConnections } from '../lib/metrics';
import { sseTicketService } from '../services/SSETicketService';

const router = Router();
const logger = createLogger('SSE');

const MAX_STREAMS_PER_USER = 5;
const MAX_STREAMS_PER_PROCESS = 150; // below eventBus.setMaxListeners(200)
const userStreams = new Map<string, number>();
let totalStreams = 0;

/**
 * @openapi
 * /realtime/stream:
 *   get:
 *     tags: [Realtime]
 *     summary: Server-Sent Events stream for real-time job progress
 *     description: |
 *       Streams `job_progress` events for the authenticated user.
 *       Authentication: Pass an SSE ticket as `?ticket=<ticket>` (preferred)
 *       or send the JWT in the `Authorization: Bearer <jwt>` header.
 *       The JWT is never accepted as a query parameter.
 *     parameters:
 *       - in: query
 *         name: ticket
 *         schema:
 *           type: string
 *         description: Short-lived SSE ticket (preferred, from POST /auth/sse-ticket)
 *     responses:
 *       200:
 *         description: SSE stream (text/event-stream)
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       401:
 *         description: Missing or invalid credentials
 *       429:
 *         description: Too many concurrent streams for this user or process
 */
router.get('/stream', async (req: AuthRequest, res: Response) => {
  let userId: string | undefined;

  // Preferred: SSE ticket
  const queryTicket = req.query.ticket as string | undefined;
  if (queryTicket) {
    userId = (await sseTicketService.validateAndConsume(queryTicket)) ?? undefined;
    if (!userId) {
      res.status(401).json({ message: 'Invalid or expired SSE ticket' });
      return;
    }
  } else {
    // Fallback: Accept token from the Authorization header only.
    // Query-string tokens are rejected to avoid leaking JWTs via URLs/logs.
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    if (!token) {
      res.status(401).json({ message: 'Missing ticket or token' });
      return;
    }

    try {
      const payload = verifyAccessToken(token);
      userId = payload.sub as string;
    } catch {
      res.status(401).json({ message: 'Invalid or expired token' });
      return;
    }
  }

  if (
    (userStreams.get(userId) ?? 0) >= MAX_STREAMS_PER_USER ||
    totalStreams >= MAX_STREAMS_PER_PROCESS
  ) {
    res.status(429).json({ message: 'Too many concurrent SSE connections' });
    return;
  }
  userStreams.set(userId, (userStreams.get(userId) ?? 0) + 1);
  totalStreams++;
  sseConnections.set(totalStreams);

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  logger.info(`SSE client connected`, { userId });
  const send = (event: string, data: unknown, id?: string) => {
    if (id) res.write(`id: ${id}\n`);
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial connected event
  send('connected', { userId, ts: Date.now() });

  // Heartbeat every 25s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  // Forward job progress events for this user
  // Replay events missed during a reconnect gap, then stream live ones
  // (buffering live events until replay finishes keeps ordering intact).
  const lastEventId = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10);
  let lastSent = Number.isFinite(lastEventId) ? lastEventId : 0;
  let replaying = Number.isFinite(lastEventId);
  const pending: JobProgressEvent[] = [];

  const deliver = (event: JobProgressEvent) => {
    const seq = event.seq ?? 0;
    if (seq && seq <= lastSent) return;
    if (seq) lastSent = seq;
    send('job_progress', event, seq ? String(seq) : undefined);
  };

  const onJob = (event: JobProgressEvent) => {
    if (replaying) pending.push(event);
    else deliver(event);
  };

  eventBus.onUserJob(userId, onJob);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    eventBus.offUserJob(userId, onJob);
    const remaining = (userStreams.get(userId) ?? 1) - 1;
    if (remaining <= 0) userStreams.delete(userId);
    else userStreams.set(userId, remaining);
    totalStreams--;
    sseConnections.set(totalStreams);
    logger.info(`SSE client disconnected`, { userId });
  });

  if (replaying) {
    try {
      for (const event of await eventBus.getMissedEvents(userId, lastSent)) deliver(event);
    } catch (err) {
      logger.warn('SSE replay failed', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    replaying = false;
    pending.splice(0).forEach(deliver);
  }
});

export default router;
