import { prisma } from '../lib/prisma';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export interface RefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  jti: string;
  createdAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}

export interface CreateRefreshTokenInput {
  userId: string;
  tokenHash: string;
  jti: string;
  createdAt?: Date;
  expiresAt: Date;
  userAgent?: string | null;
  ip?: string | null;
}

/** Maximum number of concurrent sessions retained per user. */
export const MAX_REFRESH_TOKENS_PER_USER = 10;

const normaliseEmail = (email: string): string => email.trim().toLowerCase();

export const UserStore = {
  findByEmail: (email: string): Promise<User | null> =>
    prisma.user.findUnique({ where: { email: normaliseEmail(email) } }),

  findById: (id: string): Promise<User | null> => prisma.user.findUnique({ where: { id } }),

  create: (user: User): Promise<User> =>
    prisma.user.create({
      data: {
        id: user.id,
        email: normaliseEmail(user.email),
        passwordHash: user.passwordHash,
        createdAt: user.createdAt,
      },
    }),

  update: (id: string, patch: Partial<User>): Promise<User | null> => {
    const data: Partial<User> = { ...patch };
    if (typeof data.email === 'string') {
      data.email = normaliseEmail(data.email);
    }
    return prisma.user.update({ where: { id }, data }).catch(() => null);
  },

  /** Delete all users — intended for test teardown only. */
  clear: (): Promise<void> => {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('UserStore.clear() is only available in test mode');
    }
    return prisma.user.deleteMany().then(() => undefined);
  },
};

export const RefreshTokenStore = {
  createRefreshToken: (input: CreateRefreshTokenInput): Promise<RefreshToken> =>
    prisma.refreshToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        jti: input.jti,
        createdAt: input.createdAt ?? new Date(),
        expiresAt: input.expiresAt,
        userAgent: input.userAgent ?? null,
        ip: input.ip ?? null,
      },
    }),

  /**
   * Insert a refresh token while enforcing the per-user session cap.
   * Sessions beyond the cap are evicted oldest-first. Runs in a transaction
   * so concurrent logins cannot exceed the cap.
   */
  createRefreshTokenCapped: (
    input: CreateRefreshTokenInput,
    maxSessions: number = MAX_REFRESH_TOKENS_PER_USER,
  ): Promise<RefreshToken> =>
    prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({
        data: {
          userId: input.userId,
          tokenHash: input.tokenHash,
          jti: input.jti,
          createdAt: input.createdAt ?? new Date(),
          expiresAt: input.expiresAt,
          userAgent: input.userAgent ?? null,
          ip: input.ip ?? null,
        },
      });

      const sessions = await tx.refreshToken.findMany({
        where: { userId: input.userId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });

      if (sessions.length > maxSessions) {
        const staleIds = sessions.slice(maxSessions).map((s) => s.id);
        await tx.refreshToken.deleteMany({ where: { id: { in: staleIds } } });
      }

      return created;
    }),

  findRefreshTokenByHash: (tokenHash: string): Promise<RefreshToken | null> =>
    prisma.refreshToken.findUnique({ where: { tokenHash } }),

  deleteRefreshTokenByHash: (tokenHash: string): Promise<boolean> =>
    prisma.refreshToken
      .delete({ where: { tokenHash } })
      .then(() => true)
      .catch(() => false),

  deleteAllRefreshTokensForUser: (userId: string): Promise<number> =>
    prisma.refreshToken.deleteMany({ where: { userId } }).then((res) => res.count),

  pruneExpiredRefreshTokens: (now: Date = new Date()): Promise<number> =>
    prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } }).then((res) => res.count),
};