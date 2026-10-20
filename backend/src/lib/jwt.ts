import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { config } from '../config';

export type TokenType = 'access' | 'refresh';

export interface TokenPayload extends JwtPayload {
  sub: string;
  jti: string;
  typ: TokenType;
}

const ALGORITHM = 'HS256';

function baseSignOptions(expiresIn: SignOptions['expiresIn']): SignOptions {
  return {
    algorithm: ALGORITHM,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    expiresIn,
  };
}

/**
 * Sign an access token for the given user.
 * Includes a unique `jti` so blacklist keys never collide (#1739) and a
 * `typ` claim so access/refresh tokens cannot be confused (#1741).
 */
export function signAccessToken(userId: string): string {
  const payload: Pick<TokenPayload, 'sub' | 'jti' | 'typ'> = {
    sub: userId,
    jti: randomUUID(),
    typ: 'access',
  };
  return jwt.sign(payload, config.JWT_SECRET, baseSignOptions(config.JWT_EXPIRES_IN));
}

/**
 * Sign a refresh token for the given user.
 */
export function signRefreshToken(userId: string): string {
  const payload: Pick<TokenPayload, 'sub' | 'jti' | 'typ'> = {
    sub: userId,
    jti: randomUUID(),
    typ: 'refresh',
  };
  return jwt.sign(payload, config.JWT_REFRESH_SECRET, baseSignOptions(config.JWT_REFRESH_EXPIRES_IN));
}

function verifyWithType(token: string, secret: string, expectedType: TokenType): TokenPayload {
  const decoded = jwt.verify(token, secret, {
    algorithms: [ALGORITHM],
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  });

  if (typeof decoded === 'string' || decoded === null) {
    throw new jwt.JsonWebTokenError('Invalid token payload');
  }

  const payload = decoded as TokenPayload;

  if (payload.typ !== expectedType) {
    throw new jwt.JsonWebTokenError(
      `Invalid token type: expected "${expectedType}", got "${String(payload.typ)}"`,
    );
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new jwt.JsonWebTokenError('Invalid token payload: missing subject');
  }

  return payload;
}

/**
 * Verify an access token, pinning algorithm, issuer, audience and type.
 */
export function verifyAccessToken(token: string): TokenPayload {
  return verifyWithType(token, config.JWT_SECRET, 'access');
}

/**
 * Verify a refresh token, pinning algorithm, issuer, audience and type.
 */
export function verifyRefreshToken(token: string): TokenPayload {
  return verifyWithType(token, config.JWT_REFRESH_SECRET, 'refresh');
}

/**
 * Decode a token without verifying its signature. Intended only for the
 * pre-Redis expiry short-circuit; never use this for authorization decisions.
 */
export function decodeToken(token: string): TokenPayload | null {
  const decoded = jwt.decode(token);
  if (typeof decoded === 'string' || decoded === null) {
    return null;
  }
  return decoded as TokenPayload;
}