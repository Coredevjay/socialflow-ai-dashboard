import { Router, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest } from '../middleware/authenticate';
import { eventBus, JobProgressEvent } from '../lib/eventBus';
import { createLogger } from '../lib/logger';
import { config } from '../config/config';
import { sseTicketService } from '../services/SSETicketService';

const router = Router();
const logger = createLogger('SSE');

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
 */
router.get('/stream', (req: AuthRequest, res: Response) => {
  let userId: string | undefined;

  // Preferred: SSE ticket
  const queryTicket = req.query.ticket as string | undefined;
  if (queryTicket) {
    userId = sseTicketService.validateAndConsume(queryTicket) ?? undefined;
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
      const payload = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;
      userId = payload.sub as string;
    } catch {
      res.status(401).json({ message: 'Invalid or expired token' });
      return;
    }
  }

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
  const onJob = (event: JobProgressEvent) => {
    send('job_progress', event, `${event.jobId}-${event.progress}`);
  };

  eventBus.onUserJob(userId, onJob);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    eventBus.offUserJob(userId, onJob);
    logger.info(`SSE client disconnected`, { userId });
  });
});

export default router;
