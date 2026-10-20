/**
 * Database integration tests — UserRepository
 *
 * Requires a running PostgreSQL instance with the schema migrated.
 * Set TEST_DATABASE_URL or DATABASE_URL to point at the test DB.
 *
 * Run:
 *   npx jest --selectProjects db --runInBand
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { UserRepository } from '../../repositories/UserRepository';
import { createTestPrisma, truncateAll } from './dbClient';

// Bypass Redis cache so tests hit the DB directly
jest.mock('../../utils/cache', () => ({
  withCache: jest.fn((_k: string, _t: number, fn: () => any) => fn()),
  invalidateCache: jest.fn(() => Promise.resolve()),
  invalidateCachePattern: jest.fn(() => Promise.resolve()),
  CacheTTL: { USER_PROFILE: 300 },
}));

let db: PrismaClient;
let repo: UserRepository;

beforeAll(async () => {
  db = createTestPrisma();
  repo = new UserRepository(db);
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function userPayload(overrides: Partial<{ email: string }> = {}) {
  return {
    id: randomUUID(),
    email: overrides.email ?? `user-${randomUUID()}@example.com`,
    passwordHash: 'hashed',
    refreshTokens: [],
    lastPasswordChange: new Date(),
  };
}

// ── create ────────────────────────────────────────────────────────────────────
describe('UserRepository.create', () => {
  it('persists a new user and returns it', async () => {
    const payload = userPayload({ email: 'alice@example.com' });
    const user = await repo.create(payload);

    expect(user.id).toBe(payload.id);
    expect(user.email).toBe('alice@example.com');
    expect(user.deletedAt).toBeNull();
  });

  it('throws on duplicate email (P2002)', async () => {
    const payload = userPayload({ email: 'dup@example.com' });
    await repo.create(payload);

    await expect(repo.create({ ...payload, id: randomUUID() })).rejects.toMatchObject({
      code: 'P2002',
    });
  });
});

// ── findById ──────────────────────────────────────────────────────────────────
describe('UserRepository.findById', () => {
  it('returns the user without sensitive fields when it exists', async () => {
    const payload = userPayload();
    await repo.create(payload);

    const found = await repo.findById(payload.id);
    expect(found?.id).toBe(payload.id);
    expect(found).not.toHaveProperty('passwordHash');
    expect(found).not.toHaveProperty('refreshTokens');
  });

  it('returns null for an unknown id', async () => {
    expect(await repo.findById(randomUUID())).toBeNull();
  });
});

// ── findByIdWithSensitive ──────────────────────────────────────────────────────
describe('UserRepository.findByIdWithSensitive', () => {
  it('returns the full user including passwordHash and refreshTokens', async () => {
    const payload = userPayload();
    await repo.create(payload);

    const found = await repo.findByIdWithSensitive(payload.id);
    expect(found?.id).toBe(payload.id);
    expect(found).toHaveProperty('passwordHash');
    expect(found).toHaveProperty('refreshTokens');
  });

  it('returns null for an unknown id', async () => {
    expect(await repo.findByIdWithSensitive(randomUUID())).toBeNull();
  });
});

// ── findByEmail ───────────────────────────────────────────────────────────────
describe('UserRepository.findByEmail', () => {
  it('returns the user when it exists', async () => {
    const payload = userPayload({ email: 'bob@example.com' });
    await repo.create(payload);

    const found = await repo.findByEmail('bob@example.com');
    expect(found?.email).toBe('bob@example.com');
  });

  it('returns null for an unknown email', async () => {
    expect(await repo.findByEmail('ghost@example.com')).toBeNull();
  });
});

// ── update ────────────────────────────────────────────────────────────────────
describe('UserRepository.update', () => {
  it('updates a field and returns the updated record', async () => {
    const payload = userPayload();
    await repo.create(payload);

    const updated = await repo.update(payload.id, { passwordHash: 'new-hash' });
    expect(updated?.passwordHash).toBe('new-hash');
  });

  it('returns null for a non-existent user (P2025)', async () => {
    expect(await repo.update(randomUUID(), { passwordHash: 'new-hash' })).toBeNull();
  });
});

// ── delete (soft-delete) ──────────────────────────────────────────────────────
describe('UserRepository.delete — soft-delete', () => {
  it('sets deletedAt instead of removing the row', async () => {
    const payload = userPayload();
    await repo.create(payload);

    await repo.delete(payload.id);

    // Soft-delete middleware filters deletedAt IS NULL on finds, so findById returns null
    expect(await repo.findById(payload.id)).toBeNull();

    // But the row still exists in the DB when queried without the filter
    const raw = await db.user.findFirst({
      where: { id: payload.id, deletedAt: { not: null } },
    });
    expect(raw?.deletedAt).not.toBeNull();
  });

  it('returns null when deleting a non-existent user', async () => {
    expect(await repo.delete(randomUUID())).toBeNull();
  });

  it('does not return soft-deleted users in findByEmail', async () => {
    const payload = userPayload({ email: 'deleted@example.com' });
    await repo.create(payload);
    await repo.delete(payload.id);

    expect(await repo.findByEmail('deleted@example.com')).toBeNull();
  });
});
