import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimit';
import { predictiveService } from '../services/PredictiveService';
import { validate } from '../middleware/validate';

const router = Router();

const predictReachSchema = z.object({
  content: z.string().min(1),
  platform: z.enum(['instagram', 'tiktok', 'facebook', 'youtube', 'linkedin', 'x']),
  scheduledTime: z.string().datetime().optional().transform((v) => v ? new Date(v) : undefined),
  hashtags: z.array(z.string()).optional(),
  mentions: z.array(z.string()).optional(),
  mediaType: z.enum(['text', 'image', 'video', 'carousel']).optional(),
  followerCount: z.number().int().positive().optional(),
});

router.post(
  '/reach',
  generalLimiter,
  authenticate,
  validate(predictReachSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const prediction = await predictiveService.predictReach(req.body);
      res.json({ success: true, data: prediction });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  },
);

// History endpoint — returns 404 until persistence is implemented
router.get(
  '/history/:postId',
  generalLimiter,
  authenticate,
  async (_req: Request, res: Response): Promise<void> => {
    res.status(404).json({ success: false, message: 'Post history not yet implemented' });
  },
);

router.get(
  '/metrics',
  generalLimiter,
  authenticate,
  (_req: Request, res: Response): void => {
    res.json({ success: true, data: predictiveService.getModelMetrics() });
  },
);

export default router;
