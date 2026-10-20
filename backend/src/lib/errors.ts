/**
 * Custom Application Error Classes
 *
 * These classes provide standardized error handling across the application.
 * Each error class maps to a specific HTTP status code and error type.
 */

/**
 * Base Application Error
 * All custom errors extend this class
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, code: string, isOperational = true) {
    super(message);

    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;

    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace(this, this.constructor);

    // Set the prototype explicitly for proper instanceof checks
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * 400 Bad Request
 * Client sent invalid data or malformed request
 */
export class BadRequestError extends AppError {
  constructor(message = 'Bad request', code = 'BAD_REQUEST') {
    super(message, 400, code);
    Object.setPrototypeOf(this, BadRequestError.prototype);
  }
}

/**
 * 401 Unauthorized
 * Authentication is required or has failed
 */
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', code = 'UNAUTHORIZED') {
    super(message, 401, code);
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

/**
 * 403 Forbidden
 * User is authenticated but doesn't have permission
 */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', code = 'FORBIDDEN') {
    super(message, 403, code);
    Object.setPrototypeOf(this, ForbiddenError.prototype);
  }
}

/**
 * 404 Not Found
 * Requested resource doesn't exist
 */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code = 'NOT_FOUND') {
    super(message, 404, code);
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * 409 Conflict
 * Request conflicts with current state (e.g., duplicate resource)
 */
export class ConflictError extends AppError {
  constructor(message = 'Conflict', code = 'CONFLICT') {
    super(message, 409, code);
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

/**
 * 402 Payment Required
 * User does not have enough credits for the requested action
 */
export class InsufficientCreditsError extends AppError {
  constructor(required: number, available: number, code = 'INSUFFICIENT_CREDITS') {
    super(`Insufficient credits. Required: ${required}, available: ${available}`, 402, code);
    Object.setPrototypeOf(this, InsufficientCreditsError.prototype);
  }
}

/**
 * 403 Forbidden
 * Subscription exists but is not active or trialing
 */
export class SubscriptionInactiveError extends AppError {
  constructor(message = 'Subscription is not active', code = 'SUBSCRIPTION_INACTIVE') {
    super(message, 403, code);
    Object.setPrototypeOf(this, SubscriptionInactiveError.prototype);
  }
}

/**
 * 404 Not Found
 * User has no billing subscription provisioned
 */
export class NotProvisionedError extends AppError {
  constructor(message = 'No subscription found for user', code = 'NOT_PROVISIONED') {
    super(message, 404, code);
    Object.setPrototypeOf(this, NotProvisionedError.prototype);
  }
}

/**
 * 422 Unprocessable Entity
 * Request is well-formed but contains semantic errors
 */
export class ValidationError extends AppError {
  public readonly errors?: Record<string, string[]>;

  constructor(
    message = 'Validation failed',
    errors?: Record<string, string[]>,
    code = 'VALIDATION_ERROR',
  ) {
    super(message, 422, code);
    this.errors = errors;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * 429 Too Many Requests
 * Rate limit exceeded
 */
export class RateLimitError extends AppError {
  public readonly retryAfter?: number;

  constructor(message = 'Too many requests', retryAfter?: number, code = 'RATE_LIMIT_EXCEEDED') {
    super(message, 429, code);
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/**
 * 500 Internal Server Error
 * Unexpected server error
 */
export class InternalServerError extends AppError {
  constructor(message = 'Internal server error', code = 'INTERNAL_SERVER_ERROR') {
    super(message, 500, code, false); // Not operational - unexpected error
    Object.setPrototypeOf(this, InternalServerError.prototype);
  }
}

/**
 * 503 Service Unavailable
 * Service is temporarily unavailable (maintenance, overload, etc.)
 */
export class ServiceUnavailableError extends AppError {
  public readonly retryAfter?: number;

  constructor(message = 'Service unavailable', retryAfter?: number, code = 'SERVICE_UNAVAILABLE') {
    super(message, 503, code);
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, ServiceUnavailableError.prototype);
  }
}

/**
 * Database Error
 * Database operation failed
 */
export class DatabaseError extends AppError {
  constructor(message = 'Database error', code = 'DATABASE_ERROR') {
    super(message, 500, code, false);
    Object.setPrototypeOf(this, DatabaseError.prototype);
  }
}

/**
 * External Service Error
 * External API or service call failed
 */
export class ExternalServiceError extends AppError {
  public readonly service?: string;

  constructor(
    message = 'External service error',
    service?: string,
    code = 'EXTERNAL_SERVICE_ERROR',
  ) {
    super(message, 502, code);
    this.service = service;
    Object.setPrototypeOf(this, ExternalServiceError.prototype);
  }
}

/**
 * Type guard to check if error is an AppError
 */
export const isAppError = (error: unknown): error is AppError => {
  return error instanceof AppError;
};

/**
 * Type guard to check if error is operational (expected) vs programming error
 */
export const isOperationalError = (error: unknown): boolean => {
  if (isAppError(error)) {
    return error.isOperational;
  }
  return false;
};

/**
 * Type guard to check if error is a Prisma unique constraint violation (P2002)
 * Useful for translating duplicate-key errors into 409 Conflict responses.
 */
export const isUniqueConstraintError = (error: unknown): boolean => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
};
