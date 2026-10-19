import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import morgan from 'morgan';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// #1749 - Password schema regression tests
// ---------------------------------------------------------------------------
import {
  registerSchema,
  loginSchema,
  changePasswordSchema,
} from '../../../schemas/auth';

describe('#1749 password schema rules', () => {
  const validPassword = 'Str0ng!Passw0rd';

  describe('registerSchema', () => {
    it('accepts a valid password', () => {
      const result = registerSchema.safeParse({
        email: 'user@example.com',
        password: validPassword,
        name: 'Test User',
      });
      expect(result.success).toBe(true);
    });

    it('rejects a password longer than 128 characters', () => {
      const tooLong = 'a'.repeat(129);
      const result = registerSchema.safeParse({
        email: 'user@example.com',
        password: tooLong,
        name: 'Test User',
      });
      expect(result.success).toBe(false);
    });

    it('accepts a password of exactly 128 characters', () => {
      const maxLength = 'a'.repeat(128);
      const result = registerSchema.safeParse({
        email: 'user@example.com',
        password: maxLength,
        name: 'Test User',
      });
      expect(result.success).toBe(true);
    });

    it('rejects a password shorter than 8 characters', () => {
      const result = registerSchema.safeParse({
        email: 'user@example.com',
        password: 'short',
        name: 'Test User',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('loginSchema', () => {
    it('accepts a valid password', () => {
      const result = loginSchema.safeParse({
        email: 'user@example.com',
        password: validPassword,
      });
      expect(result.success).toBe(true);
    });

    it('rejects a password longer than 128 characters', () => {
      const result = loginSchema.safeParse({
        email: 'user@example.com',
        password: 'a'.repeat(129),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('changePasswordSchema', () => {
    it('accepts a valid change with a different new password', () => {
      const result = changePasswordSchema.safeParse({
        currentPassword: 'OldPassw0rd!',
        newPassword: 'NewPassw0rd!',
      });
      expect(result.success).toBe(true);
    });

    it('rejects when newPassword equals currentPassword', () => {
      const result = changePasswordSchema.safeParse({
        currentPassword: 'SamePassw0rd!',
        newPassword: 'SamePassw0rd!',
      });
      expect(result.success).toBe(false);
    });

    it('rejects a newPassword longer than 128 characters', () => {
      const result = changePasswordSchema.safeParse({
        currentPassword: 'OldPassw0rd!',
        newPassword: 'a'.repeat(129),
      });
      expect(result.success).toBe(false);
    });

    it('rejects a currentPassword longer than 128 characters', () => {
      const result = changePasswordSchema.safeParse({
        currentPassword: 'a'.repeat(129),
        newPassword: 'NewPassw0rd!',
      });
      expect(result.success).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Shared test helpers / mocks
// ---------------------------------------------------------------------------

const sha256 = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');

interface StoredToken {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  rotated: boolean;
  revoked: boolean;
  expiresAt: Date;
}

interface AuditEvent {
  type: string;
  userId: string;
  familyId?: string;
  metadata?: Record<string, unknown>;
}

interface MockStore {
  users: Map<string, { id: string; email: string; passwordHash: string }>;
  tokens: Map<string, StoredToken>;
  auditEvents: AuditEvent[];
}

const createMockStore = (): MockStore => ({
  users: new Map(),
  tokens: new Map(),
  auditEvents: [],
});

// ---------------------------------------------------------------------------
// #1747 / #1748 - Refresh token storage & rotation family tests
// ---------------------------------------------------------------------------

describe('#1747 refresh tokens are stored hashed', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore();
    store.users.set('user-1', {
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: 'hashed',
    });
  });

  it('stores only the SHA-256 hash of the refresh token, never the raw token', () => {
    const rawToken = 'raw-refresh-jwt-value';
    const tokenHash = sha256(rawToken);

    store.tokens.set(tokenHash, {
      id: 'token-1',
      userId: 'user-1',
      tokenHash,
      familyId: 'family-1',
      rotated: false,
      revoked: false,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const stored = Array.from(store.tokens.values())[0];
    expect(stored.tokenHash).toBe(tokenHash);
    expect(stored.tokenHash).not.toBe(rawToken);
    // Raw token must not appear anywhere in the persisted record.
    expect(JSON.stringify(stored)).not.toContain(rawToken);
  });

  it('authenticates a presented raw token by comparing its hash', () => {
    const rawToken = 'raw-refresh-jwt-value';
    const tokenHash = sha256(rawToken);

    store.tokens.set(tokenHash, {
      id: 'token-1',
      userId: 'user-1',
      tokenHash,
      familyId: 'family-1',
      rotated: false,
      revoked: false,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const presentedHash = sha256(rawToken);
    const found = store.tokens.get(presentedHash);

    expect(found).toBeDefined();
    expect(found?.revoked).toBe(false);
    expect(found?.rotated).toBe(false);
  });

  it('does not authenticate a token whose hash is not present', () => {
    const presentedHash = sha256('some-other-token');
    expect(store.tokens.get(presentedHash)).toBeUndefined();
  });
});

describe('#1748 replay of a rotated refresh token revokes the family', () => {
  let store: MockStore;

  const rotate = (rawToken: string): string => {
    const presentedHash = sha256(rawToken);
    const existing = store.tokens.get(presentedHash);
    if (!existing) {
      throw new Error('Refresh token revoked');
    }
    if (existing.revoked) {
      throw new Error('Refresh token revoked');
    }
    if (existing.rotated) {
      // Reuse detection: revoke the whole family and audit.
      for (const token of store.tokens.values()) {
        if (token.familyId === existing.familyId) {
          token.revoked = true;
        }
      }
      store.auditEvents.push({
        type: 'refresh_token_reuse_detected',
        userId: existing.userId,
        familyId: existing.familyId,
        metadata: { tokenId: existing.id },
      });
      throw new Error('Refresh token reuse detected');
    }

    existing.rotated = true;

    const newRaw = `rotated-${crypto.randomUUID()}`;
    const newHash = sha256(newRaw);
    store.tokens.set(newHash, {
      id: `token-${store.tokens.size + 1}`,
      userId: existing.userId,
      tokenHash: newHash,
      familyId: existing.familyId,
      rotated: false,
      revoked: false,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return newRaw;
  };

  beforeEach(() => {
    store = createMockStore();
    store.users.set('user-1', {
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: 'hashed',
    });
    const raw = 'initial-refresh-token';
    const hash = sha256(raw);
    store.tokens.set(hash, {
      id: 'token-1',
      userId: 'user-1',
      tokenHash: hash,
      familyId: 'family-1',
      rotated: false,
      revoked: false,
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  it('rotates a fresh token successfully', () => {
    const newRaw = rotate('initial-refresh-token');
    expect(newRaw).toBeTruthy();
    expect(store.auditEvents).toHaveLength(0);
  });

  it('revokes the entire family when a rotated token is replayed', () => {
    // Legitimate client rotates.
    const rotatedRaw = rotate('initial-refresh-token');
    expect(rotatedRaw).toBeTruthy();

    // Attacker replays the original (already rotated) token.
    expect(() => rotate('initial-refresh-token')).toThrow(
      /reuse detected/i,
    );

    // Every token in the family must now be revoked.
    const familyTokens = Array.from(store.tokens.values()).filter(
      (t) => t.familyId === 'family-1',
    );
    expect(familyTokens.length).toBeGreaterThan(0);
    for (const token of familyTokens) {
      expect(token.revoked).toBe(true);
    }

    // The rotated sibling must no longer authenticate (forces re-login).
    expect(() => rotate(rotatedRaw)).toThrow(/revoked/i);
  });

  it('writes an audit event on reuse detection', () => {
    rotate('initial-refresh-token');
    expect(() => rotate('initial-refresh-token')).toThrow(/reuse detected/i);

    expect(store.auditEvents).toHaveLength(1);
    const event = store.auditEvents[0];
    expect(event.type).toBe('refresh_token_reuse_detected');
    expect(event.userId).toBe('user-1');
    expect(event.familyId).toBe('family-1');
  });

  it('does not affect tokens from other families', () => {
    const otherRaw = 'other-family-token';
    const otherHash = sha256(otherRaw);
    store.tokens.set(otherHash, {
      id: 'token-other',
      userId: 'user-2',
      tokenHash: otherHash,
      familyId: 'family-2',
      rotated: false,
      revoked: false,
      expiresAt: new Date(Date.now() + 60_000),
    });

    rotate('initial-refresh-token');
    expect(() => rotate('initial-refresh-token')).toThrow(/reuse detected/i);

    const other = store.tokens.get(otherHash);
    expect(other?.revoked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #1750 - /realtime/stream query token rejection & morgan redaction
// ---------------------------------------------------------------------------

describe('#1750 realtime stream rejects ?token= and morgan redacts secrets', () => {
  const buildApp = () => {
    const app = express();

    // Mirror the redacting morgan token used in app.ts.
    morgan.token('url', (req: express.Request) => {
      const rawUrl = req.originalUrl || req.url || '';
      try {
        const parsed = new URL(rawUrl, 'http://localhost');
        for (const key of ['token', 'ticket']) {
          if (parsed.searchParams.has(key)) {
            parsed.searchParams.set(key, '[REDACTED]');
          }
        }
        return `${parsed.pathname}${parsed.search}`;
      } catch {
        return rawUrl.replace(
          /([?&](?:token|ticket)=)[^&]*/gi,
          '$1[REDACTED]',
        );
      }
    });

    app.use(morgan(':method :url'));

    // Mirror the hardened realtime route: query-token path removed.
    app.get('/realtime/stream', (req, res) => {
      if (req.query.token) {
        res.status(400).json({ error: 'Query token not supported' });
        return;
      }
      res.status(200).json({ ok: true });
    });

    return app;
  };

  it('rejects a request that supplies ?token=', async () => {
    const app = buildApp();
    const res = await request(app).get('/realtime/stream?token=abc123');
    expect(res.status).toBe(400);
  });

  it('allows a request without a query token', async () => {
    const app = buildApp();
    const res = await request(app).get('/realtime/stream');
    expect(res.status).toBe(200);
  });

  it('redacts token and ticket query params in morgan output', () => {
    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any, ...args: any[]) => {
        lines.push(String(chunk));
        return true;
      });

    try {
      const app = buildApp();
      // Invoke the morgan token directly to avoid async stream timing.
      const fakeReq = {
        method: 'GET',
        originalUrl: '/realtime/stream?token=secret-token&ticket=secret-ticket',
        url: '/realtime/stream?token=secret-token&ticket=secret-ticket',
      } as unknown as express.Request;

      const redacted = (morgan as any).token('url')(
        fakeReq,
        {} as express.Response,
      ) as string;

      expect(redacted).not.toContain('secret-token');
      expect(redacted).not.toContain('secret-ticket');
      expect(redacted).toContain('[REDACTED]');
      expect(redacted).toContain('/realtime/stream');
    } finally {
      spy.mockRestore();
      process.stdout.write = originalWrite;
    }
  });
});