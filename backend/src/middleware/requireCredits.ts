import { Response, NextFunction } from 'express';
import { AuthRequest } from './authenticate';
import { billingService } from '../services/BillingService';
import { AppError } from '../lib/errors';
import { CreditAction } from '../models/Subscription';

/**
 * Middleware factory that deducts credits before allowing an action.
 * Must be used after `authMiddleware`.
 *
 * Usage:
 *   router.post('/generate', authMiddleware, requireCredits('ai:generate'), handler)
 */
export function requireCredits(action: CreditAction) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    try {
      const balance = await billingService.deductCredits(userId, action);
      // Expose remaining balance to downstream handlers
      (req as any).creditsRemaining = balance;
      next();
    } catch (err) {
      if (err instanceof AppError) {
        res.status(err.statusCode).json({ message: err.message, code: err.code });
        return;
      }
      next(err);
    }
  };
}
