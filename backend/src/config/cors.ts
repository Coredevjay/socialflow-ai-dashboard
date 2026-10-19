import { CorsOptions } from 'cors';
import { ForbiddenError } from '../lib/errors';
import { config } from './config';

/**
 * Allowed origins per environment.
 * Keys MUST match the real NODE_ENV values used throughout the codebase
 * (see backend/src/config/config.ts's Zod schema): development, test, production.
 * To add a new origin: append it to the relevant array below.
 *   - development: local dev machines / localhost variants
 *   - test:        CI / automated test runs (treated like development)
 *   - production:  production domains only
 */
const ALLOWED_ORIGINS: Record<string, string[]> = {
  development: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'],
  test: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'],
  production: ['https://socialflow.app', 'https://www.socialflow.app'],
};

// Read the same NODE_ENV value the rest of the app validates against, rather
// than re-reading process.env with a different set of expected values —
// previously this used 'local'/'staging'/'prod' keys that never matched the
// actual NODE_ENV of 'development'/'test'/'production', so production
// silently fell back to the localhost allowlist.
const env = config.NODE_ENV;

/**
 * Flattened list of origins allowed for the current environment. Exported so
 * other places that need to validate an application-controlled origin
 * (e.g. Stripe Checkout success/cancel URLs) can reuse the same allow-list
 * instead of accepting arbitrary attacker-supplied domains.
 */
const configuredOrigins = config.CORS_ALLOWED_ORIGINS;
export const allowedOrigins: string[] = configuredOrigins !== undefined
  ? configuredOrigins.split(',').map((origin) => origin.trim()).filter(Boolean)
  : ALLOWED_ORIGINS[env] ?? ALLOWED_ORIGINS.development;

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Allow server-to-server requests (no Origin header) only outside production
    if (!origin && env !== 'production') return callback(null, true);
    if (origin && allowedOrigins.includes(origin)) return callback(null, true);
    callback(new ForbiddenError('Origin not allowed by CORS policy', 'CORS_ORIGIN_FORBIDDEN'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
