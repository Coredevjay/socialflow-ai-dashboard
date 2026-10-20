import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticate as authMiddleware } from '../middleware/authenticate';
import { checkPermission } from '../middleware/checkPermission';
import { createUploadStorage } from '../lib/uploadStorage';
import { z } from 'zod';
import { ImageOptimizationService } from '../services/ImageOptimizationService';

const router = Router();

const imageQuerySchema = z.object({
  width: z.coerce.number().int().min(1).max(4096).optional(),
  height: z.coerce.number().int().min(1).max(4096).optional(),
  quality: z.coerce.number().int().min(1).max(100).default(80),
  format: z.enum(['webp', 'jpeg', 'png']).default('webp'),
});

const UPLOAD_BASE = path.resolve(process.cwd(), 'uploads');

const storage = createUploadStorage('images');

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid image format'));
    }
  },
});

/**
 * @openapi
 * /images/upload:
 *   post:
 *     tags: [Images]
 *     summary: Upload and optimize an image
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [image]
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *                 description: Image file (jpeg, png, webp, gif — max 50 MB)
 *     parameters:
 *       - in: query
 *         name: width
 *         schema:
 *           type: integer
 *       - in: query
 *         name: height
 *         schema:
 *           type: integer
 *       - in: query
 *         name: quality
 *         schema:
 *           type: integer
 *           default: 80
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [webp, jpeg, png]
 *           default: webp
 *     responses:
 *       200:
 *         description: Optimized image binary
 *         content:
 *           image/*:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: No image provided
 */
// Required permission: posts:create
router.post(
  '/upload',
  authMiddleware,
  checkPermission('posts:create'),
  upload.single('image'),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image provided' });
      }

      const parsed = imageQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid image options', details: parsed.error.issues });
      }
      const options = parsed.data;

      const {
        buffer,
        format: resultFormat,
        cacheKey,
        etag,
      } = await ImageOptimizationService.optimize(req.file.path, options);

      res.setHeader('Content-Type', `image/${resultFormat}`);
      res.setHeader('Cache-Control', 'private, max-age=300, must-revalidate');
      res.setHeader('ETag', etag);
      res.setHeader('X-Cache-Key', cacheKey);
      res.send(buffer);
    } catch (error) {
      console.error('Image optimization error:', error);
      res.status(500).json({ error: 'Failed to optimize image' });
    }
  },
);

/**
 * @openapi
 * /images/proxy:
 *   get:
 *     tags: [Images]
 *     summary: Proxy and optimize an image from a file path
 *     parameters:
 *       - in: query
 *         name: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Relative path under uploads/
 *       - in: query
 *         name: width
 *         schema:
 *           type: integer
 *       - in: query
 *         name: height
 *         schema:
 *           type: integer
 *       - in: query
 *         name: quality
 *         schema:
 *           type: integer
 *           default: 80
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [webp, jpeg, png]
 *           default: webp
 *     responses:
 *       200:
 *         description: Optimized image binary
 *         content:
 *           image/*:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Missing or invalid path
 */
router.get('/proxy', authMiddleware, checkPermission('posts:create'), async (req: Request, res: Response) => {
  try {
    const { path: imagePath } = req.query;

    if (!imagePath || typeof imagePath !== 'string') {
      return res.status(400).json({ error: 'path parameter required' });
    }

    const parsed = imageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid image options', details: parsed.error.issues });
    }
    const options = parsed.data;

    // Security: prevent directory traversal via resolve + realpath
    const requestedPath = path.resolve(UPLOAD_BASE, imagePath);
    if (!requestedPath.startsWith(UPLOAD_BASE + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    let fullPath: string;
    try {
      fullPath = fs.realpathSync(requestedPath);
    } catch {
      return res.status(404).json({ error: 'Not found' });
    }
    if (!fullPath.startsWith(UPLOAD_BASE + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }


    const {
      buffer,
      format: resultFormat,
      cacheKey,
      etag,
    } = await ImageOptimizationService.optimize(fullPath, options);

    res.setHeader('Content-Type', `image/${resultFormat}`);
    res.setHeader('Cache-Control', 'private, max-age=300, must-revalidate');
    res.setHeader('ETag', etag);
    res.setHeader('X-Cache-Key', cacheKey);
    res.send(buffer);
  } catch (error) {
    console.error('Image proxy error:', error);
    res.status(500).json({ error: 'Failed to proxy image' });
  }
});

/**
 * @openapi
 * /images/cache/size:
 *   get:
 *     tags: [Images]
 *     summary: Get image cache size
 *     responses:
 *       200:
 *         description: Cache size in bytes and MB
 */
router.get('/cache/size', authMiddleware, checkPermission('settings:manage'), async (req: Request, res: Response) => {
  try {
    const size = await ImageOptimizationService.getCacheSize();
    res.json({ cacheSize: size, cacheSizeMB: (size / 1024 / 1024).toFixed(2) });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to get cache size' });
  }
});

/**
 * @openapi
 * /images/cache:
 *   delete:
 *     tags: [Images]
 *     summary: Clear the image optimization cache
 *     responses:
 *       200:
 *         description: Cache cleared
 */
// Required permission: settings:manage
router.delete(
  '/cache',
  authMiddleware,
  checkPermission('settings:manage'),
  async (req: Request, res: Response) => {
    try {
      await ImageOptimizationService.clearCache();
      res.json({ message: 'Cache cleared' });
    } catch (_error) {
      res.status(500).json({ error: 'Failed to clear cache' });
    }
  },
);

export default router;
