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

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(8).max(128),
    newPassword: z.string().min(8).max(128),
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: 'New password must be different from the current password',
    path: ['newPassword'],
  });
