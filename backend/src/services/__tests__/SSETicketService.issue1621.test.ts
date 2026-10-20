jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// Minimal in-memory Redis stand-in shared by "all replicas"
const store = new Map<string, string>();
jest.mock('../../lib/redis', () => ({
  redis: {
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    getdel: jest.fn(async (k: string) => {
      const v = store.get(k) ?? null;
      store.delete(k);
      return v;
    }),
  },
}));

import { redis } from '../../lib/redis';
import { sseTicketService } from '../SSETicketService';

describe('SSETicketService', () => {
  beforeEach(() => store.clear());

  it('issues a 64-char hex ticket stored in Redis with a 30s TTL', async () => {
    const ticket = await sseTicketService.generateTicket('user-1');
    expect(ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(redis.set).toHaveBeenCalledWith(`sse:ticket:${ticket}`, 'user-1', 'EX', 30);
  });

  it('issues unique tickets', async () => {
    const a = await sseTicketService.generateTicket('user-1');
    const b = await sseTicketService.generateTicket('user-1');
    expect(a).not.toBe(b);
  });

  it('consumes a valid ticket and returns the userId', async () => {
    const ticket = await sseTicketService.generateTicket('user-2');
    expect(await sseTicketService.validateAndConsume(ticket)).toBe('user-2');
  });

  it('rejects reuse of a consumed ticket', async () => {
    const ticket = await sseTicketService.generateTicket('user-3');
    expect(await sseTicketService.validateAndConsume(ticket)).toBe('user-3');
    expect(await sseTicketService.validateAndConsume(ticket)).toBeNull();
  });

  it('rejects unknown, forged or expired tickets', async () => {
    expect(await sseTicketService.validateAndConsume('f'.repeat(64))).toBeNull();
    expect(await sseTicketService.validateAndConsume('')).toBeNull();
  });
});
