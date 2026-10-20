import { BillingService } from '../BillingService';
import { prisma } from '../../lib/prisma';
import Stripe from 'stripe';

jest.mock('../../lib/prisma', () => ({
  prisma: {
    subscription: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    creditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('stripe', () => jest.fn());
jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const p = prisma as any;
const stripeMock = {
  subscriptions: { retrieve: jest.fn() },
  prices: { retrieve: jest.fn() },
  webhooks: { constructEvent: jest.fn() },
};

const localSub = {
  userId: 'u1',
  plan: 'pro',
  creditsMonthly: 1000,
  creditsRemaining: 900,
  stripeCustomerId: 'cus_1',
};

function fire(type: string, object: any) {
  stripeMock.webhooks.constructEvent.mockReturnValue({ type, data: { object } });
  return new BillingService().handleWebhook(Buffer.from('x'), 'sig');
}

describe('BillingService webhook sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Stripe as unknown as jest.Mock).mockImplementation(() => stripeMock);
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec';
    p.subscription.findFirst.mockResolvedValue(localSub);
    p.$transaction.mockImplementation((fn: any) => fn(p));
  });

  it('ignores a stale updated event when Stripe says the subscription is canceled', async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', status: 'canceled', items: { data: [] } });
    await fire('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', status: 'active' });
    expect(p.subscription.update).not.toHaveBeenCalled();
  });

  it('skips unknown plan metadata and empty items', async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', status: 'active', items: { data: [] } });
    await fire('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1' });
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_1', status: 'active', items: { data: [{ price: { id: 'p1' }, current_period_end: 1 }] },
    });
    stripeMock.prices.retrieve.mockResolvedValue({ product: { metadata: { plan: 'bogus' } } });
    await fire('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1' });
    expect(p.subscription.update).not.toHaveBeenCalled();
  });

  it('adjusts credits on plan change', async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_1', status: 'active', items: { data: [{ price: { id: 'p1' }, current_period_end: 1 }] },
    });
    stripeMock.prices.retrieve.mockResolvedValue({ product: { metadata: { plan: 'enterprise' } } });
    await fire('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1' });
    const data = p.subscription.update.mock.calls[0][0].data;
    expect(data.plan).toBe('enterprise');
    expect(data.creditsMonthly).toBe(10000);
    expect(data.creditsRemaining).toBe(9900);
  });

  it('downgrades to free on deletion, clamps credits and logs', async () => {
    p.subscription.update.mockResolvedValue({ creditsRemaining: 20 });
    await fire('customer.subscription.deleted', { id: 'sub_1' });
    const data = p.subscription.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ plan: 'free', status: 'canceled', creditsMonthly: 20, creditsRemaining: 20, stripeSubscriptionId: null });
    expect(p.creditLog.create.mock.calls[0][0].data).toMatchObject({ delta: -880, balanceAfter: 20 });
  });
});
