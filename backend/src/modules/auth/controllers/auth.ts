import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'crypto';
import { UserStore } from '../../../models/User';
import { auditLogger } from '../../../services/AuditLogger';
import { PasswordHistoryService } from '../../../services/PasswordHistoryService';
import { AuthBlacklistService } from '../../../services/AuthBlacklistService';
import { redisAccountLockoutStore } from '../../../services/AccountLockoutService';
import { prisma } from '../../../lib/prisma';
import { config } from '../../../config/config';

const SALT_ROUNDS = 12;

// Maximum number of concurrent refresh-token sessions kept per user.
const MAX_SESSIONS_PER_USER = 10;

// Fixed cost-12 bcrypt hash used to equalise login timing when the account
// does not exist, so response time does not reveal account existence.
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO5ZBj3pQ0jJ0h9b7cQ0h1oQ8oQ0h1oQ0';

const jwtSecret = () => config.JWT_SECRET;
const jwtExpiresIn = () => config.JWT_EXPIRES_IN;
const jwtRefreshSecret = () => config.JWT_REFRESH_SECRET;
const jwtRefreshExpiresIn = () => config.JWT_REFRESH_EXPIRES_IN;

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function signAccess(userId: string): string {
  return jwt.sign({ sub: userId }, jwtSecret(), { expiresIn: jwtExpiresIn() } as jwt.SignOptions);
}

function signRefresh(userId: string): string {
  return jwt.sign({ sub: userId, jti: randomUUID() }, jwtRefreshSecret(), {
    expiresIn: jwtRefreshExpiresIn(),
  } as jwt.SignOptions);
}

function refreshExpiryDate(): Date {
  const decoded = jwt.decode(signRefresh('expiry-probe')) as jwt.JwtPayload | null;
  const exp = decoded?.exp;
  return exp ? new Date(exp * 1000) : new Date(Date.now() + 7 * 24 * 3600 * 1000);
}

/**
 * Persist a refresh token session row and enforce the per-user session cap by
 * deleting the oldest rows beyond the cap.
 */
async function persistRefreshToken(
  userId: string,
  refreshToken: string,
  req: Request,
): Promise<void> {
  const payload = jwt.decode(refreshToken) as jwt.JwtPayload | null;
  const jti = (payload?.jti as string) ?? randomUUID();
  const expiresAt = payload?.exp ? new Date(payload.exp * 1000) : refreshExpiryDate();

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(refreshToken),
      jti,
      createdAt: new Date(),
      expiresAt,
      userAgent: req.headers['user-agent'] ?? null,
      ip: req.ip ?? null,
    },
  });

  const stale = await prisma.refreshToken.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    skip: MAX_SESSIONS_PER_USER,
    select: { id: true },
  });
  if (stale.length > 0) {
    await prisma.refreshToken.deleteMany({
      where: { id: { in: stale.map((row) => row.id) } },
    });
  }
}

export async function register(req: Request, res: Response): Promise<void> {
  const { email: rawEmail, password } = req.body as { email: string; password: string };
  const email = normaliseEmail(rawEmail);

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  let user;
  try {
    user = await UserStore.create({
      id: randomUUID(),
      email,
      passwordHash,
      createdAt: new Date(),
      refreshTokens: [],
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      // Rely on the unique constraint rather than a check-then-create race.
      res.status(409).json({ message: 'Email already registered' });
      return;
    }
    throw err;
  }

  const accessToken = signAccess(user.id);
  const refreshToken = signRefresh(user.id);
  await persistRefreshToken(user.id, refreshToken, req);

  auditLogger.log({
    actorId: user.id,
    action: 'auth:register',
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.status(201).json({ accessToken, refreshToken });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email: rawEmail, password } = req.body as { email: string; password: string };
  const email = normaliseEmail(rawEmail);

  // Per-account lockout, independent of the caller's IP — the authLimiter
  // middleware only throttles by IP, so a distributed attack against a single
  // account would otherwise never trip any protection.
  if (await redisAccountLockoutStore.isLockedOut(email)) {
    res.status(429).json({
      message: 'Account temporarily locked due to too many failed login attempts. Try again later.',
    });
    return;
  }

  const user = await UserStore.findByEmail(email);
  // Always run a bcrypt comparison, even for unknown accounts, so response
  // timing does not reveal whether the email exists.
  const passwordMatches = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !passwordMatches) {
    await redisAccountLockoutStore.recordFailedAttempt(email);
    res.status(401).json({ message: 'Invalid credentials' });
    return;
  }

  await redisAccountLockoutStore.resetFailedAttempts(email);

  const rotationRequired = await PasswordHistoryService.isRotationRequired(user.id);

  const accessToken = signAccess(user.id);
  const refreshToken = signRefresh(user.id);
  await persistRefreshToken(user.id, refreshToken, req);

  auditLogger.log({
    actorId: user.id,
    action: 'auth:login',
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.json({ accessToken, refreshToken, passwordRotationRequired: rotationRequired });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as { refreshToken: string };

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(refreshToken, jwtRefreshSecret()) as jwt.JwtPayload;
  } catch {
    res.status(401).json({ message: 'Invalid or expired refresh token' });
    return;
  }

  const userId = payload.sub as string;
  const tokenHash = hashToken(refreshToken);

  const user = await UserStore.findById(userId);
  if (!user) {
    res.status(401).json({ message: 'Refresh token revoked' });
    return;
  }

  // Blacklist the consumed refresh token to prevent replay
  const tokenKey = AuthBlacklistService.keyFromPayload(payload);
  const ttl = payload.exp ? payload.exp - Math.floor(Date.now() / 1000) : 7 * 24 * 3600;
  await AuthBlacklistService.blacklistToken(tokenKey, ttl);

  // Rotate: conditionally delete the presented row, then insert the new one.
  const newRefresh = signRefresh(user.id);
  const newPayload = jwt.decode(newRefresh) as jwt.JwtPayload | null;
  const newJti = (newPayload?.jti as string) ?? randomUUID();
  const newExpiresAt = newPayload?.exp
    ? new Date(newPayload.exp * 1000)
    : refreshExpiryDate();

  const rotated = await prisma.$transaction(async (tx) => {
    const deleted = await tx.refreshToken.deleteMany({
      where: { userId, tokenHash },
    });
    if (deleted.count === 0) {
      return false;
    }
    await tx.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(newRefresh),
        jti: newJti,
        createdAt: new Date(),
        expiresAt: newExpiresAt,
        userAgent: req.headers['user-agent'] ?? null,
        ip: req.ip ?? null,
      },
    });
    return true;
  });

  if (!rotated) {
    res.status(401).json({ message: 'Refresh token revoked' });
    return;
  }

  res.json({ accessToken: signAccess(user.id), refreshToken: newRefresh });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as { refreshToken: string };

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(refreshToken, jwtRefreshSecret()) as jwt.JwtPayload;
  } catch {
    res.status(401).json({ message: 'Invalid token' });
    return;
  }

  const user = await UserStore.findById(payload.sub as string);
  if (user) {
    await prisma.refreshToken.deleteMany({
      where: { userId: user.id, tokenHash: hashToken(refreshToken) },
    });
    auditLogger.log({
      actorId: user.id,
      action: 'auth:logout',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  // Blacklist the current access token if present in the Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const accessToken = authHeader.slice(7);
    try {
      const accessPayload = jwt.verify(accessToken, jwtSecret()) as jwt.JwtPayload;
      const tokenKey = AuthBlacklistService.keyFromPayload(accessPayload);
      const ttl = accessPayload.exp
        ? accessPayload.exp - Math.floor(Date.now() / 1000)
        : AuthBlacklistService.accessTokenTTL();
      await AuthBlacklistService.blacklistToken(tokenKey, ttl);
    } catch {
      // Access token already expired or invalid — nothing to blacklist
    }
  }

  res.status(204).send();
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const { currentPassword, newPassword } = req.body as {
    currentPassword: string;
    newPassword: string;
  };
  const userId = (req as any).user?.id;

  if (!userId) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(404).json({ message: 'User not found' });
    return;
  }

  // Verify current password
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    res.status(401).json({ message: 'Current password is incorrect' });
    return;
  }

  // Check if new password was recently used
  if (await PasswordHistoryService.isPasswordReused(userId, newPassword)) {
    res.status(400).json({ message: 'Cannot reuse one of your last 5 passwords' });
    return;
  }

  // Hash and record the new password
  const newPasswordHash = await PasswordHistoryService.hashPassword(newPassword);
  await PasswordHistoryService.recordPasswordChange(userId, newPasswordHash);

  // Invalidate all existing refresh tokens
  await prisma.refreshToken.deleteMany({ where: { userId } });

  // Blacklist the current access token — forces re-login after password change
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const accessToken = authHeader.slice(7);
    try {
      const accessPayload = jwt.verify(accessToken, jwtSecret()) as jwt.JwtPayload;
      const tokenKey = AuthBlacklistService.keyFromPayload(accessPayload);
      const ttl = accessPayload.exp
        ? accessPayload.exp - Math.floor(Date.now() / 1000)
        : AuthBlacklistService.accessTokenTTL();
      await AuthBlacklistService.blacklistToken(tokenKey, ttl);
    } catch {
      // Token already expired — nothing to blacklist
    }
  }

  auditLogger.log({
    actorId: userId,
    action: 'auth:change-password',
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.json({ message: 'Password changed successfully' });
}
