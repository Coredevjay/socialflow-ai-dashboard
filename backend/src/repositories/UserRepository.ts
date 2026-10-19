import { PrismaClient, User, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../lib/prisma';
import { withCache, invalidateCache, CacheTTL } from '../utils/cache';

export type CreateUserInput = Prisma.UserCreateInput;
export type UpdateUserInput = Prisma.UserUpdateInput;

type UserWithoutSensitive = Omit<User, 'passwordHash' | 'refreshTokens'>;

/**
 * Fields that must never be exposed through cached read paths.
 * Refresh tokens are stored hashed (#1747) and must not be selected here.
 */
const SENSITIVE_USER_FIELDS = ['passwordHash', 'refreshTokens'] as const;

/**
 * UserRepository
 *
 * Encapsulates all database operations for the User model.
 * Accepts an optional PrismaClient so it can be easily tested with a mock.
 *
 * When to use which user data-access path (see #1591):
 * - `UserRepository` / `userRepository`: read paths that benefit from the
 *   `user:<id>` cache and the sensitive-field exclusion (`findById`), or
 *   write paths that must invalidate that cache (`update`, `delete`).
 *   Prefer this for user lookups in request handlers.
 * - `UserStore`: higher-level user domain logic (registration, credential
 *   flows, token handling) that composes multiple operations.
 * - Direct `prisma.user.*`: one-off queries inside transactions or where the
 *   cache must be bypassed (e.g. auth credential checks needing
 *   `findByIdWithSensitive`/`findByEmail`).
 */
export class UserRepository {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  /**
   * Find a user by their unique ID.
   * Returns null when no matching record exists.
   */
  async findById(id: string): Promise<UserWithoutSensitive | null> {
    return withCache(`user:${id}`, CacheTTL.USER_PROFILE, async () => {
      const user = await this.db.user.findUnique({ where: { id } });
      if (!user) return null;
      // Strip sensitive fields so they are never cached or returned.
      const { passwordHash, refreshTokens, ...safe } = user;
      void passwordHash;
      void refreshTokens;
      return safe;
    });
  }

  /**
   * Find a user by ID including sensitive fields (password hash, hashed
   * refresh tokens). Bypasses the cache so sensitive data is never cached.
   */
  async findByIdWithSensitive(id: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { id } });
  }

  /**
   * Find a user by their email address.
   * Returns null when no matching record exists.
   *
   * Emails are stored normalised (trimmed and lower-cased), so the lookup
   * value is normalised the same way to keep lookups case-insensitive.
   */
  async findByEmail(email: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  }

  /**
   * Find a user by email without sensitive fields.
   * Returns null when no matching record exists.
   */
  async findByEmailSafe(email: string): Promise<UserWithoutSensitive | null> {
    const user = await this.db.user.findUnique({ where: { email } });
    if (!user) return null;
    const { passwordHash, refreshTokens, ...safe } = user;
    void passwordHash;
    void refreshTokens;
    return safe;
  }

  /**
   * Create a new user record.
   * Throws a Prisma error if the email is already taken.
   */
  async create(data: CreateUserInput): Promise<User> {
    return this.db.user.create({ data });
  }

  /**
   * Update an existing user by ID.
   * Returns the updated record, or null if the user does not exist.
   */
  async update(id: string, data: UpdateUserInput): Promise<User | null> {
    try {
      const user = await this.db.user.update({ where: { id }, data });
      await invalidateCache(`user:${id}`);
      return user;
    } catch (err) {
      // P2025 — record not found
      if ((err as any)?.code === 'P2025') return null;
      throw err;
    }
  }

  /**
   * Soft-delete a user by ID (sets deletedAt via the soft-delete middleware).
   * Returns the deleted record, or null if the user does not exist.
   */
  async delete(id: string): Promise<User | null> {
    try {
      const user = await this.db.user.delete({ where: { id } });
      // The soft-delete middleware sets `deletedAt`; invalidate the cached
      // `user:<id>` entry so the active-user check in `authenticate` sees the
      // deletion immediately (#1742).
      await invalidateCache(`user:${id}`);
      return user;
    } catch (err) {
      if ((err as any)?.code === 'P2025') return null;
      throw err;
    }
  }
}

/** Singleton instance for use across the application */
export const userRepository = new UserRepository();

export { SENSITIVE_USER_FIELDS };
