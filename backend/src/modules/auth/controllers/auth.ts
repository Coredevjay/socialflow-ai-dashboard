import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { UserStore } from '../../../models/User';
import { auditLogger } from '../../../services/AuditLogger';
import { PasswordHistoryService } from '../../../services/PasswordHistoryService';
import { AuthBlacklistService } from '../../../services/AuthBlacklistService';
import { redisAccountLockoutStore } from '../../../services/AccountLockoutService';
import { prisma } from '../../../lib/prisma';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../../lib/jwt';

const SALT_ROUNDS = 12;

export async function register(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email: string; password: string };

  if (await UserStore.findByEmail(email)) {
    res.status(409).json({ message: 'Email already registered' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await UserStore.create({
    id: randomUUID(),
    email,
    passwordHash,
    createdAt: new Date(),
    refreshTokens: [],
  });

  const accessToken = signAccessToken(user.id);
  const refreshToken = signRefreshToken(user.id);
  await UserStore.update(user.id, { refreshTokens: [refreshToken] });

  auditLogger.log({
    actorId: user.id,
    action: 'auth:register',
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.status(201).json({ accessToken, refreshToken });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email: string; password: string };

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
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    await redisAccountLockoutStore.recordFailedAttempt(email);
    res.status(401).json({ message: 'Invalid credentials' });
    return;
  }

  await redisAccountLockoutStore.resetFailedAttempts(email);

  const rotationRequired = await PasswordHistoryService.isRotationRequired(user.id);

  const accessToken = signAccessToken(user.id);
  const refreshToken = signRefreshToken(user.id);
  await UserStore.update(user.id, { refreshTokens: [...user.refreshTokens, refreshToken] });

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

  let payload: { sub: string; exp?: number };
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    res.status(401).json({ message: 'Invalid or expired refresh token' });
    return;
  }

  const user = await UserStore.findById(payload.sub);
  if (!user || user.deletedAt || !user.refreshTokens.includes(refreshToken)) {
    res.status(401).json({ message: 'Refresh token revoked' });
    return;
  }

  // Blacklist the consumed refresh token to prevent replay
  const tokenKey = AuthBlacklistService.keyFromPayload(payload);
  const ttl = payload.exp ? payload.exp - Math.floor(Date.now() / 1000) : 7 * 24 * 3600;
  await AuthBlacklistService.blacklistToken(tokenKey, ttl);

  // Rotate refresh token
  const newRefresh = signRefreshToken(user.id);
  await UserStore.update(user.id, {
    refreshTokens: [...user.refreshTokens.filter((t) => t !== refreshToken), newRefresh],
  });

  res.json({ accessToken: signAccessToken(user.id), refreshToken: newRefresh });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as { refreshToken: string };

  let payload: { sub: string; exp?: number };
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    res.status(401).json({ message: 'Invalid token' });
    return;
  }

  const user = await UserStore.findById(payload.sub);
  if (user) {
    await UserStore.update(user.id, {
      refreshTokens: user.refreshTokens.filter((t) => t !== refreshToken),
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
      const accessPayload = verifyAccessToken(accessToken);
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
  await UserStore.update(userId, { refreshTokens: [] });

  // Blacklist the current access token — forces re-login after password change
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const accessToken = authHeader.slice(7);
    try {
      const accessPayload = verifyAccessToken(accessToken);
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
