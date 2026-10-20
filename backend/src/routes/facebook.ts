import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { authenticate as authMiddleware } from '../middleware/authenticate';
import { checkPermission } from '../middleware/checkPermission';
import { facebookService, FacebookPostRequest } from '../services/FacebookService';
import { createLogger } from '../lib/logger';
import { saveOAuthState, consumeOAuthState } from '../lib/redis';

const router = Router();
const logger = createLogger('facebook-routes');

/**
 * GET /api/facebook/auth
 * Redirects the user to Facebook's OAuth2 consent screen.
 */
router.get('/auth', authMiddleware, async (req: Request, res: Response) => {
  if (!facebookService.isConfigured()) {
    return res.status(503).json({ error: 'Facebook API not configured.' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  const userId = (req as any).user?.id;
  if (!userId) {
    return res.status(500).json({ error: 'Unable to initiate OAuth flow.' });
  }
  await saveOAuthState('facebook', state, userId);
  return res.redirect(facebookService.getAuthUrl(state));
});

/**
 * GET /api/facebook/callback
 * Handles the OAuth2 redirect, exchanges the code for tokens,
 * and returns the list of pages the user manages.
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

  const userId = await consumeOAuthState('facebook', state);
  if (!userId) {
    return res.status(400).json({ error: 'Invalid state parameter.' });
  }

  try {
    // Exchange code for user access token
    const { userAccessToken, expiresAt: _expiresAt } = await facebookService.exchangeCode(code);

    // Get long-lived token for better token management
    const longLivedToken = await facebookService.getLongLivedUserToken(userAccessToken);

    // Get the user's pages
    const pages = await facebookService.getUserPages(longLivedToken.accessToken);

    return res.json({
      message: 'Facebook connected successfully.',
      expiresAt: longLivedToken.expiresAt,
      pages: pages.map((page) => ({
        id: page.id,
        name: page.name,
        category: page.category,
        picture: page.picture?.data?.url,
      })),
    });
  } catch (err) {
    logger.error('OAuth callback failed', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to complete OAuth flow.' });
  }
});

/**
 * GET /api/facebook/pages
 * Returns the list of pages the user manages.
 * Expects ?access_token=<token>
 */
router.get('/pages', async (req: Request, res: Response) => {
  const accessToken = req.query.access_token as string;
  if (!accessToken) {
    return res.status(400).json({ error: 'access_token query param required.' });
  }

  try {
    const pages = await facebookService.getUserPages(accessToken);
    return res.json({
      pages: pages.map((page) => ({
        id: page.id,
        name: page.name,
        category: page.category,
        picture: page.picture?.data?.url,
      })),
    });
  } catch (err) {
    logger.error('Failed to fetch pages', { error: (err as Error).message });
    return res.status(502).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/facebook/post
 * Creates a post on a Facebook Page.
 * Body: { pageId, message, imageUrl?, scheduledTime? }
 * Header: x-facebook-token (user access token)
 */
// Required permission: posts:create
router.post(
  '/post',
  authMiddleware,
  checkPermission('posts:create'),
  async (req: Request, res: Response) => {
    const accessToken = req.headers['x-facebook-token'] as string;
    const { pageId, message, imageUrl, scheduledTime } = req.body;

    if (!accessToken) {
      return res.status(400).json({ error: 'x-facebook-token header required.' });
    }

    if (!pageId || !message) {
      return res.status(400).json({ error: 'pageId and message are required.' });
    }

    try {
      const postRequest: FacebookPostRequest = {
        pageId,
        message,
        imageUrl,
        scheduledTime: scheduledTime ? new Date(scheduledTime) : undefined,
      };

      const post = await facebookService.postToPageWithUserToken(accessToken, postRequest);
      return res.json({
        success: true,
        post: {
          id: post.id,
          message: post.message,
          created_time: post.created_time,
          permalink_url: post.permalink_url,
        },
      });
    } catch (err) {
      logger.error('Failed to create post', { error: (err as Error).message });
      return res.status(502).json({ error: 'Internal server error' });
    }
  },
);

/**
 * GET /api/facebook/post/:pageId/:postId/comments
 * Gets comments for a specific post.
 * Expects ?access_token=<token>
 */
router.get('/post/:pageId/:postId/comments', async (req: Request, res: Response) => {
  const { pageId, postId } = req.params;
  const accessToken = req.query.access_token as string;

  if (!accessToken) {
    return res.status(400).json({ error: 'access_token query param required.' });
  }

  try {
    const comments = await facebookService.getPostComments(pageId, postId, accessToken);
    return res.json({ comments });
  } catch (err) {
    logger.error('Failed to fetch comments', { error: (err as Error).message });
    return res.status(502).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/facebook/comment/:commentId/reply
 * Replies to a comment.
 * Body: { message }
 * Header: x-facebook-token
 */
// Required permission: posts:create
router.post(
  '/comment/:commentId/reply',
  authMiddleware,
  checkPermission('posts:create'),
  async (req: Request, res: Response) => {
    const accessToken = req.headers['x-facebook-token'] as string;
    const { commentId } = req.params;
    const { message, pageId } = req.body;

    if (!accessToken) {
      return res.status(400).json({ error: 'x-facebook-token header required.' });
    }

    if (!message || !pageId) {
      return res.status(400).json({ error: 'message and pageId are required.' });
    }

    try {
      const result = await facebookService.replyToComment(pageId, commentId, message, accessToken);
      return res.json({ success: true, commentId: result.id });
    } catch (err) {
      logger.error('Failed to reply to comment', { error: (err as Error).message });
      return res.status(502).json({ error: 'Internal server error' });
    }
  },
);

/**
 * DELETE /api/facebook/comment/:commentId
 * Deletes a comment (for moderation).
 * Header: x-facebook-token
 * Query: pageId, access_token
 */
// Required permission: posts:delete
router.delete(
  '/comment/:commentId',
  authMiddleware,
  checkPermission('posts:delete'),
  async (req: Request, res: Response) => {
    const accessToken = req.query.access_token as string;
    const { commentId } = req.params;

    if (!accessToken) {
      return res.status(400).json({ error: 'access_token query param required.' });
    }

    try {
      const result = await facebookService.deleteComment(commentId, accessToken);
      return res.json({ success: result });
    } catch (err) {
      logger.error('Failed to delete comment', { error: (err as Error).message });
      return res.status(502).json({ error: 'Internal server error' });
    }
  },
);

/**
 * GET /api/facebook/page/:pageId/insights
 * Gets insights for a specific page.
 * Expects ?access_token=<token>
 */
router.get('/page/:pageId/insights', async (req: Request, res: Response) => {
  const { pageId } = req.params;
  const accessToken = req.query.access_token as string;

  if (!accessToken) {
    return res.status(400).json({ error: 'access_token query param required.' });
  }

  try {
    const insights = await facebookService.getPageInsights(pageId, accessToken);
    return res.json(insights);
  } catch (err) {
    logger.error('Failed to fetch page insights', { error: (err as Error).message });
    return res.status(502).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/facebook/status
 * Returns circuit breaker status and configuration health.
 */
router.get('/status', (_req: Request, res: Response) => {
  return res.json({
    configured: facebookService.isConfigured(),
    circuit: facebookService.getCircuitStatus(),
  });
});

export default router;
