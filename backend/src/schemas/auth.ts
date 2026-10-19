import { z } from 'zod';

/**
 * Validation schemas for /api/auth routes.
 *
 * Adding a new rule:
 *   1. Add/extend the relevant schema below using Zod's chainable API.
 *   2. Pass the schema to the `validate()` middleware in the route file.
 *
 * Available Zod primitives: z.string(), z.number(), z.boolean(), z.enum(),
 * z.object(), z.array(), z.optional(), z.nullable(), and more — see https://zod.dev
 */

/**
 * Maximum password length in characters.
 *
 * bcrypt silently truncates input at 72 bytes, and without an upper bound an
 * attacker can post multi-megabyte passwords to force expensive hashing work.
 * 128 characters comfortably covers passphrases while staying well clear of
 * the truncation boundary for multi-byte input.
 */
export const MAX_PASSWORD_LENGTH = 128;

export const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(MAX_PASSWORD_LENGTH),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(8).max(MAX_PASSWORD_LENGTH),
    newPassword: z.string().min(8).max(MAX_PASSWORD_LENGTH),
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: 'New password must be different from the current password',
    path: ['newPassword'],
  });