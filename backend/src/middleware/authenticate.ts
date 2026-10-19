import { Request, Response, NextFunction } from 'express';
import { AuthBlacklistService } from '../services/AuthBlacklistService';
import { verifyAccessToken, decodeToken } from '../lib/jwt';
import { userRepository } from '../repositories/userRepository';

export interface AuthRequest extends Request {
  user?: { id: string };
  activeOrgId?: string;
}

export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice(7);

  // Short-circuit: decode without verification to check expiry before touching Redis.
  // This avoids a round-trip to the blacklist store for tokens that are already expired.
  const decoded = decodeToken(token);
  if (!decoded || (typeof decoded.exp === 'number' && decoded.exp * 1000 < Date.now())) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const tokenKey = AuthBlacklistService.keyFromPayload(payload);
  const blacklistResult = await AuthBlacklistService.isBlacklisted(tokenKey);
  if (blacklistResult === 'unavailable') {
    // Redis is down and fail-closed policy is enabled: reject rather than fail open.
    res.status(503).json({ message: 'Service Unavailable' });
    return;
  }
  if (blacklistResult === true) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const userId = payload.sub as string;

  // Cheap cached existence/active check. userRepository.findById caches under `user:<id>`
  // and selects `deletedAt`, so this avoids a DB round-trip on the hot path.
  const user = await userRepository.findById(userId);
  if (!user || user.deletedAt) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  req.user = { id: userId };
  next();
}