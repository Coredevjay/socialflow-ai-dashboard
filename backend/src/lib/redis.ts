import Redis from 'ioredis';
import { getRedisConnection } from '../config/runtime';

/**
 * Singleton ioredis client built from the validated config singleton.
 * Import this instead of constructing `new Redis(process.env.*)` directly.
 */
export const redis = new Redis(getRedisConnection());

/**
 * TTL (in seconds) for OAuth `state` values stored at /auth time.
 */
export const OAUTH_STATE_TTL = 600;

/**
 * Build the Redis key used to map an OAuth `state` value to the user id
 * that initiated the flow.
 */
function oauthStateKey(provider: string, state: string): string {
  return `oauth:state:${provider}:${state}`;
}

/**
 * Persist the mapping `state -> userId` for the given provider with a TTL.
 * Called when the OAuth flow is initiated so the callback can resolve the
 * user without relying on `req.user`.
 */
export async function saveOAuthState(
  provider: string,
  state: string,
  userId: string,
): Promise<void> {
  await redis.set(oauthStateKey(provider, state), userId, 'EX', OAUTH_STATE_TTL);
}

/**
 * Atomically fetch and delete the `state -> userId` mapping.
 * Returns the userId when the state was valid (and consumes it so it can
 * only be used once), or `null` when the state is unknown or expired.
 */
export async function consumeOAuthState(
  provider: string,
  state: string,
): Promise<string | null> {
  const key = oauthStateKey(provider, state);
  // GETDEL is atomic and available in Redis >= 6.2.
  const userId = await redis.getdel(key);
  return userId ?? null;
}