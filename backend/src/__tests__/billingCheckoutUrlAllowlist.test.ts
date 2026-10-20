/**
 * Billing checkout/portal redirect URL allow-list tests.
 *
 * Stripe's success_url/cancel_url/return_url are handed straight to Stripe
 * and used to redirect the payer's browser after checkout. If they aren't
 * restricted to the app's own origins, an attacker can point them at an
 * external phishing domain (open redirect after a real payment completes).
 */
import request from 'supertest';
import express, { Response, NextFunction } from 'express';
import billingRouter from '../routes/billing';

jest.mock('../middleware/authenticate', () => ({
  authenticate: (req: any, _res: Response, next: NextFunction) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

jest.mock('../models/User', () => ({
  UserStore: { findById: jest.fn().mockResolvedValue({ id: 'user-1', email: 'user@example.com' }) },
}));

const mockCreateCheckoutSession = jest.fn();
const mockCreatePortalSession = jest.fn();

jest.mock('../services/BillingService', () => ({
  billingService: {
    createCheckoutSession: (...args: unknown[]) => mockCreateCheckoutSession(...args),
    createPortalSession: (...args: unknown[]) => mockCreatePortalSession(...args),
  },
}));

jest.mock('../config/cors', () => ({
  allowedOrigins: ['https://socialflow.app', 'https://www.socialflow.app'],
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/billing', billingRouter);
  return app;
}

describe('Billing redirect URL allow-list', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects /billing/checkout with an external successUrl domain', async () => {
    const app = buildApp();
    const res = await request(app).post('/billing/checkout').send({
      plan: 'pro',
      successUrl: 'https://evil-phishing-site.example/success',
      cancelUrl: 'https://socialflow.app/cancel',
    });

    expect(res.status).toBe(400);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects /billing/checkout with an external cancelUrl domain', async () => {
    const app = buildApp();
    const res = await request(app).post('/billing/checkout').send({
      plan: 'pro',
      successUrl: 'https://socialflow.app/success',
      cancelUrl: 'https://evil-phishing-site.example/cancel',
    });

    expect(res.status).toBe(400);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('allows /billing/checkout when both URLs are on an allowed origin', async () => {
    mockCreateCheckoutSession.mockResolvedValue('https://checkout.stripe.com/session/abc');
    const app = buildApp();
    const res = await request(app).post('/billing/checkout').send({
      plan: 'pro',
      successUrl: 'https://socialflow.app/success',
      cancelUrl: 'https://www.socialflow.app/cancel',
    });

    expect(res.status).toBe(200);
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      'user-1',
      'pro',
      'https://socialflow.app/success',
      'https://www.socialflow.app/cancel',
    );
  });

  it('rejects /billing/portal with an external returnUrl domain', async () => {
    const app = buildApp();
    const res = await request(app).post('/billing/portal').send({
      returnUrl: 'https://evil-phishing-site.example/return',
    });

    expect(res.status).toBe(400);
    expect(mockCreatePortalSession).not.toHaveBeenCalled();
  });
});
