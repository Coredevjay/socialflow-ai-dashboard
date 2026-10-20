import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { authenticate as authMiddleware } from '../middleware/authenticate';
import { youTubeService } from '../services/YouTubeService';
import { enqueueYouTubeSync } from '../jobs/youtubeSyncJob';
import { createLogger } from '../lib/logger';
import { saveOAuthState, consumeOAuthState } from '../lib/redis';

const router = Router();
const logger = createLogger('youtube-routes');

/**
 * GET /api/youtube/auth
 * Redirects the user to Google's OAuth2 consent screen.
 */
router.get('/auth', authMiddleware, async (req: Request, res: Response) => {
  if (!youTubeService.isConfigured()) {
    return res.status(503).json({ error: 'YouTube API not configured.' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  const userId = (req as any).user?.id;
  if (!userId) {
    return res.status(500).json({ error: 'Unable to initiate OAuth flow.' });
  }
  await saveOAuthState('youtube', state, userId);
  return res.redirect(youTubeService.getAuthUrl(state));
});

/**
 * GET /api/youtube/callback
 * Handles the OAuth2 redirect, exchanges the code for tokens,
 * and triggers an immediate analytics sync.
 */
router.get('/callback', async (req: Request, res: Response) => {
  const { code, error, state } = req.query;

  if (error) {
    logger.warn('OAuth callback error', { error });
    return res.status(400).json({ error: String(error) });
  }

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing authorization code.' });
  }

  if (!state || typeof state !== 'string') {
    return res.status(400).json({ error: 'Missing state parameter.' });
  }

  const userId = await consumeOAuthState('youtube', state);
  if (!userId) {
    return res.status(400).json({ error: 'Invalid state parameter.' });
  }

  try {
    const tokens = await youTubeService.exchangeCode(code);
    // Trigger an immediate sync with the fresh tokens
    await enqueueYouTubeSync(tokens, userId);
    return res.json({
      message: 'YouTube connected. Analytics sync queued.',
      expiresAt: tokens.expiresAt,
    });
  } catch (err) {
    logger.error('OAuth callback failed', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to complete OAuth flow.' });
  }
});

/**
 * GET /api/youtube/channel
 * Returns channel metadata for the authenticated user.
 * Expects ?access_token=<token> (in production, read from session/DB).
 */
router.get('/channel', async (req: Request, res: Response) => {
  const accessToken = req.query.access_token as string;
  if (!accessToken) return res.status(400).json({ error: 'access_token query param required.' });

  try {
    const channel = await youTubeService.getChannel(accessToken);
    return res.json(channel);
  } catch (err) {
    logger.error('Failed to fetch channel', { error: (err as Error).message });
    return res.status(502).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/youtube/videos/stats
 * Returns statistics for given video IDs.
 * Query: access_token, ids (comma-separated)
 */
router.get('/videos/stats', async (req: Request, res: Response) => {
  const { access_token, ids } = req.query;
  if (!access_token || !ids) {
    return res.status(400).json({ error: 'access_token and ids query params required.' });
  }

  const videoIds = (ids as string)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  try {
    const stats = await youTubeService.getVideoStats(access_token as string, videoIds);
    return res.json(stats);
  } catch (err) {
    logger.error('Failed to fetch video stats', { error: (err as Error).message });
    return res.status(502).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/youtube/status
 * Returns circuit breaker status and configuration health.
 */
router.get('/status', (_req: Request, res: Response) => {
  return res.json({
    configured: youTubeService.isConfigured(),
    circuit: youTubeService.getCircuitStatus(),
  });
});

export default router;
