import {
  InsufficientCreditsError,
  NotProvisionedError,
  SubscriptionInactiveError,
  AppError,
} from '../lib/errors';

describe('billing errors', () => {
  it('map to the expected HTTP status codes', () => {
    expect(new InsufficientCreditsError(5, 2).statusCode).toBe(402);
    expect(new SubscriptionInactiveError().statusCode).toBe(403);
    expect(new NotProvisionedError().statusCode).toBe(404);
  });

  it('are AppError instances with stable codes and messages', () => {
    const err = new InsufficientCreditsError(5, 2);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('INSUFFICIENT_CREDITS');
    expect(err.message).toBe('Insufficient credits. Required: 5, available: 2');
  });
});
