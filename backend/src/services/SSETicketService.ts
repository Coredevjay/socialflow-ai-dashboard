import crypto from 'crypto';
import { redis } from '../lib/redis';
import { createLogger } from '../lib/logger';

const logger = createLogger('SSETicketService');

const TICKET_TTL_S = 30;
const ticketKey = (ticket: string) => `sse:ticket:${ticket}`;

/**
 * SSETicketService — Manages short-lived, single-use tickets for SSE connections.
 *
 * This prevents exposing long-lived JWTs in URLs/query parameters.
 * Tickets live in Redis (30 seconds, consumed atomically with GETDEL) so a
 * ticket issued by one API replica can be redeemed on any other.
 */
class SSETicketService {
  /**
   * Generate a new short-lived SSE ticket for the given user.
   *
   * @param userId - User ID from JWT payload
   * @returns A single-use ticket string (32 random bytes, hex-encoded)
   */
  async generateTicket(userId: string): Promise<string> {
    const ticket = crypto.randomBytes(32).toString('hex');
    await redis.set(ticketKey(ticket), userId, 'EX', TICKET_TTL_S);
    logger.debug(`Generated SSE ticket for user ${userId}, expires in ${TICKET_TTL_S}s`);
    return ticket;
  }

  /**
   * Validate and consume a ticket atomically.
   *
   * @param ticket - Ticket string to validate
   * @returns userId if valid and unconsumed, null otherwise
   */
  async validateAndConsume(ticket: string): Promise<string | null> {
    if (!ticket) return null;
    const userId = await redis.getdel(ticketKey(ticket));
    if (!userId) {
      logger.warn(`SSE ticket validation failed: ticket not found, expired or consumed`);
      return null;
    }
    logger.debug(`SSE ticket consumed for user ${userId}`);
    return userId;
  }
}

// Singleton instance
export const sseTicketService = new SSETicketService();
