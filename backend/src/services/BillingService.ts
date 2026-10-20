import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import {
  InsufficientCreditsError,
  NotProvisionedError,
  SubscriptionInactiveError,
  ValidationError,
} from '../lib/errors';
import { config } from '../config/config';
import {
  Subscription,
  PLAN_CREDITS,
  SubscriptionPlan,
  ACTION_COST,
  CreditAction,
} from '../models/Subscription';

const logger = createLogger('billing-service');

export type PaidPlan = Exclude<SubscriptionPlan, 'free'>;

let stripeClient: Stripe | null = null;

function stripe(): Stripe {
  if (!stripeClient) {
    if (!config.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured');
    stripeClient = new Stripe(config.STRIPE_SECRET_KEY, {
      apiVersion: '2026-02-25.clover',
      timeout: 20_000,
      maxNetworkRetries: 2,
    });
  }
  return stripeClient;
}

/** Test hook: drop the cached client so the next call rebuilds it. */
export function resetStripeClient(): void {
  stripeClient = null;
}

/** Resolve a plan key to its server-configured Stripe price id. */
function resolvePriceId(plan: PaidPlan): string {
  const priceId = {
    starter: config.STRIPE_PRICE_STARTER,
    pro: config.STRIPE_PRICE_PRO,
    enterprise: config.STRIPE_PRICE_ENTERPRISE,
  }[plan];
  if (!priceId) {
    throw new ValidationError(
      `No Stripe price configured for plan "${plan}"`,
      { plan: ['plan is not available'] },
      'PLAN_NOT_CONFIGURED',
    );
  }
  return priceId;
}

function toSubscription(row: {
  id: string;
  userId: string;
  plan: string;
  status: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  creditsRemaining: number;
  creditsMonthly: number;
  currentPeriodEnd: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): Subscription {
  return {
    id: row.id,
    userId: row.userId,
    plan: row.plan as SubscriptionPlan,
    status: row.status as Subscription['status'],
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    creditsRemaining: row.creditsRemaining,
    creditsMonthly: row.creditsMonthly,
    currentPeriodEnd: row.currentPeriodEnd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class BillingService {
  public isConfigured(): boolean {
    return !!config.STRIPE_SECRET_KEY;
  }

  /** Create or retrieve a Stripe customer and provision a free subscription */
  public async provisionUser(userId: string, email: string): Promise<Subscription> {
    const existing = await prisma.subscription.findUnique({ where: { userId } });
    if (existing) return toSubscription(existing);

    const existingCustomers = await stripe().customers.list({ email, limit: 1 });
    const customer =
      existingCustomers.data.length > 0
        ? existingCustomers.data[0]
        : await stripe().customers.create(
            { email, metadata: { userId } },
            { idempotencyKey: `provision:${userId}` },
          );

    let sub;
    try {
      sub = await prisma.subscription.create({
        data: {
          id: randomUUID(),
          userId,
          plan: 'free',
          status: 'active',
          stripeCustomerId: customer.id,
          stripeSubscriptionId: null,
          creditsRemaining: PLAN_CREDITS.free,
          creditsMonthly: PLAN_CREDITS.free,
          currentPeriodEnd: null,
        },
      });
    } catch (err) {
      // A concurrent request won the race (unique userId): return its row.
      if ((err as { code?: string }).code === 'P2002') {
        const raced = await prisma.subscription.findUnique({ where: { userId } });
        if (raced) return toSubscription(raced);
      }
      throw err;
    }

    await prisma.creditLog.create({
      data: {
        userId,
        action: 'credit:reset',
        delta: PLAN_CREDITS.free,
        balanceAfter: PLAN_CREDITS.free,
        metadata: { reason: 'initial_provision' },
      },
    });

    logger.info('User provisioned', { userId, customerId: customer.id });
    return toSubscription(sub);
  }

  /** Create a Stripe Checkout session for upgrading to a paid plan */
  public async createCheckoutSession(
    userId: string,
    plan: PaidPlan,
    successUrl: string,
    cancelUrl: string,
  ): Promise<string> {
    const priceId = resolvePriceId(plan);
    const sub = await prisma.subscription.findUnique({ where: { userId } });
    if (!sub) throw new NotProvisionedError('User not provisioned for billing');

    // Explicitly list accepted payment methods to prevent unexpected changes
    // caused by Stripe dashboard defaults. Configurable via STRIPE_PAYMENT_METHODS
    // (comma-separated, e.g. "card,link"). Defaults to card-only.
    const rawMethods = process.env.STRIPE_PAYMENT_METHODS ?? 'card';
    const paymentMethodTypes = rawMethods
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean) as Stripe.Checkout.SessionCreateParams.PaymentMethodType[];

    const session = await stripe().checkout.sessions.create({
      customer: sub.stripeCustomerId,
      mode: 'subscription',
      payment_method_types: paymentMethodTypes,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId },
    });

    return session.url!;
  }

  /** Create a Stripe Customer Portal session for managing billing */
  public async createPortalSession(userId: string, returnUrl: string): Promise<string> {
    const sub = await prisma.subscription.findUnique({ where: { userId } });
    if (!sub) throw new NotProvisionedError('User not provisioned for billing');

    const session = await stripe().billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: returnUrl,
    });

    return session.url;
  }

  /**
   * Atomically deduct credits for an action.
   * Uses a single conditional UPDATE (WHERE creditsRemaining >= cost) inside a
   * Prisma transaction so that concurrent requests for the same user cannot both
   * pass the balance check and over-deduct (TOCTOU race).
   * Throws if the subscription is missing, inactive, or has insufficient credits.
   * Returns updated balance.
   */
  public async deductCredits(userId: string, action: CreditAction): Promise<number> {
    const cost = ACTION_COST[action] ?? 1;

    return prisma.$transaction(async (tx) => {
      const sub = await tx.subscription.findUnique({ where: { userId } });
      if (!sub) throw new NotProvisionedError();
      if (sub.status !== 'active' && sub.status !== 'trialing') {
        throw new SubscriptionInactiveError();
      }

      // Atomic conditional decrement — the WHERE guard ensures only one concurrent
      // request wins when the balance is just sufficient for a single deduction.
      const updated = await tx.subscription.updateMany({
        where: { userId, creditsRemaining: { gte: cost } },
        data: { creditsRemaining: { decrement: cost } },
      });

      if (updated.count === 0) {
        throw new InsufficientCreditsError(cost, sub.creditsRemaining);
      }

      // The UPDATE above holds the row lock until commit, so this read is not stale.
      const newBalance = await this.readBalance(tx, userId);
      await tx.creditLog.create({
        data: { userId, action, delta: -cost, balanceAfter: newBalance },
      });

      return newBalance;
    });
  }

  /**
   * Atomically deduct credits proportional to actual token usage (1 credit per token).
   * Uses the same conditional-update pattern as deductCredits to prevent TOCTOU races.
   * Throws ValidationError if tokens is not a positive integer, or if the user has insufficient credits.
   * Returns updated balance.
   */
  public async deductCreditsForTokens(userId: string, tokens: number): Promise<number> {
    if (!Number.isInteger(tokens) || tokens <= 0) {
      throw new ValidationError(
        'tokens must be a positive integer',
        { tokens: ['must be a positive integer'] },
        'INVALID_TOKEN_COUNT',
      );
    }

    return prisma.$transaction(async (tx) => {
      const sub = await tx.subscription.findUnique({ where: { userId } });
      if (!sub) throw new NotProvisionedError();
      if (sub.status !== 'active' && sub.status !== 'trialing') {
        throw new SubscriptionInactiveError();
      }

      const updated = await tx.subscription.updateMany({
        where: { userId, creditsRemaining: { gte: tokens } },
        data: { creditsRemaining: { decrement: tokens } },
      });

      if (updated.count === 0) {
        throw new InsufficientCreditsError(tokens, sub.creditsRemaining);
      }

      const newBalance = await this.readBalance(tx, userId);
      await tx.creditLog.create({
        data: { userId, action: 'ai:generate', delta: -tokens, balanceAfter: newBalance },
      });

      return newBalance;
    });
  }

  /**
   * Refund credits for a previously deducted action (compensating transaction).
   * Used when a downstream operation fails after credits have already been deducted.
   * Returns the restored balance.
   */
  public async refundCredits(userId: string, action: CreditAction, reason?: string): Promise<number> {
    const sub = await prisma.subscription.findUnique({ where: { userId } });
    if (!sub) throw new NotProvisionedError();

    const cost = ACTION_COST[action] ?? 1;
    const newBalance = await prisma.$transaction(async (tx) => {
      const updated = await tx.subscription.update({
        where: { userId },
        data: { creditsRemaining: { increment: cost } },
      });
      await tx.creditLog.create({
        data: {
          userId,
          action: 'credit:topup',
          delta: cost,
          balanceAfter: updated.creditsRemaining,
          metadata: { reason: reason ?? 'refund', refundedAction: action },
        },
      });
      return updated.creditsRemaining;
    });

    logger.info('Credits refunded', { userId, action, cost, newBalance, reason });
    return newBalance;
  }

  private async readBalance(
    tx: Pick<typeof prisma, 'subscription'>,
    userId: string,
  ): Promise<number> {
    const row = await tx.subscription.findUnique({ where: { userId } });
    if (!row) throw new Error('No subscription found for user');
    return row.creditsRemaining;
  }

  /** Get the current subscription for a user */
  public async getSubscription(userId: string): Promise<Subscription | null> {
    const sub = await prisma.subscription.findUnique({ where: { userId } });
    return sub ? toSubscription(sub) : null;
  }

  /** Get the credit log history for a user */
  public async getCreditLogs(userId: string) {
    return prisma.creditLog.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  /** Handle incoming Stripe webhook events */
  public async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    // The config schema guarantees STRIPE_WEBHOOK_SECRET is present whenever
    // billing is enabled (see superRefine in config.ts).
    const secret = config.STRIPE_WEBHOOK_SECRET!;

    let event: Stripe.Event;
    try {
      event = stripe().webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      throw new Error(`Webhook signature verification failed: ${(err as Error).message}`);
    }

    logger.info('Stripe webhook received', { type: event.type });

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const stripeSub = event.data.object as Stripe.Subscription;
        await this.syncSubscription(stripeSub);
        break;
      }
      case 'customer.subscription.deleted': {
        const stripeSub = event.data.object as Stripe.Subscription;
        const sub = await prisma.subscription.findFirst({
          where: { stripeSubscriptionId: stripeSub.id },
        });
        if (sub) {
          const free = PLAN_CREDITS.free;
          await prisma.$transaction(async (tx) => {
            const updated = await tx.subscription.update({
              where: { userId: sub.userId },
              data: {
                status: 'canceled',
                stripeSubscriptionId: null,
                plan: 'free',
                creditsMonthly: free,
                creditsRemaining: Math.min(sub.creditsRemaining, free),
              },
            });
            await tx.creditLog.create({
              data: {
                userId: sub.userId,
                action: 'credit:reset',
                delta: updated.creditsRemaining - sub.creditsRemaining,
                balanceAfter: updated.creditsRemaining,
                metadata: { reason: 'subscription_canceled', stripeSubscriptionId: stripeSub.id },
              },
            });
          });
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        await this.onPaymentSucceeded(invoice);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const sub = await prisma.subscription.findFirst({
          where: { stripeCustomerId: invoice.customer as string },
        });
        if (sub) {
          await prisma.subscription.update({
            where: { userId: sub.userId },
            data: { status: 'past_due' },
          });
        }
        break;
      }
    }
  }

  private async syncSubscription(stripeSub: Stripe.Subscription): Promise<void> {
    const customerId = stripeSub.customer as string;
    const sub = await prisma.subscription.findFirst({ where: { stripeCustomerId: customerId } });
    if (!sub) {
      logger.warn('No local subscription for Stripe customer', { customerId });
      return;
    }

    // Stripe does not guarantee event ordering: re-fetch the authoritative state so a
    // delayed `updated` event cannot resurrect a cancelled subscription.
    let current: Stripe.Subscription;
    try {
      current = await stripe().subscriptions.retrieve(stripeSub.id);
    } catch (err) {
      logger.warn('Could not re-fetch Stripe subscription; skipping sync', {
        subscriptionId: stripeSub.id,
        error: (err as Error).message,
      });
      return;
    }
    if (current.status === 'canceled' || current.status === 'incomplete_expired') {
      logger.info('Ignoring stale event for ended subscription', { subscriptionId: current.id });
      return;
    }

    const item = current.items.data[0];
    if (!item) {
      logger.warn('Stripe subscription has no items; skipping sync', { subscriptionId: current.id });
      return;
    }
    const price = await stripe().prices.retrieve(item.price.id, { expand: ['product'] });
    const product = price.product as Stripe.Product;
    const plan = product.metadata?.plan as SubscriptionPlan | undefined;
    if (!plan || !Object.prototype.hasOwnProperty.call(PLAN_CREDITS, plan)) {
      logger.warn('Unknown plan in product metadata; skipping sync', {
        subscriptionId: current.id,
        plan,
      });
      return;
    }

    const data: Record<string, unknown> = {
      plan,
      status: current.status,
      stripeSubscriptionId: current.id,
      currentPeriodEnd: item.current_period_end ? new Date(item.current_period_end * 1000) : null,
    };
    if (plan !== sub.plan) {
      // Plan change: adjust the allowance, preserving credits already used this period.
      const monthly = PLAN_CREDITS[plan];
      const used = Math.max(0, sub.creditsMonthly - sub.creditsRemaining);
      data.creditsMonthly = monthly;
      data.creditsRemaining = Math.max(0, monthly - used);
    }

    await prisma.subscription.update({ where: { userId: sub.userId }, data });
  }

  private async onPaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
    if (invoice.billing_reason !== 'subscription_cycle') return;

    const sub = await prisma.subscription.findFirst({
      where: { stripeCustomerId: invoice.customer as string },
    });
    if (!sub) return;

    const monthly = PLAN_CREDITS[sub.plan as SubscriptionPlan];
    await prisma.$transaction(async (tx) => {
      const current = await tx.subscription.findUnique({ where: { userId: sub.userId } });
      const previousBalance = current?.creditsRemaining ?? sub.creditsRemaining;
      await tx.subscription.update({
        where: { userId: sub.userId },
        data: { creditsRemaining: monthly, creditsMonthly: monthly },
      });
      await tx.creditLog.create({
        data: {
          userId: sub.userId,
          action: 'credit:reset',
          delta: monthly - previousBalance,
          balanceAfter: monthly,
          metadata: { reason: 'billing_cycle_renewal', invoiceId: invoice.id },
        },
      });
    });

    logger.info('Credits reset on renewal', { userId: sub.userId, credits: monthly });
  }
}

export const billingService = new BillingService();
