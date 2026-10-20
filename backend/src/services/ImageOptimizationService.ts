import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../lib/logger';
import { BadRequestError } from '../lib/errors';

const logger = createLogger('image-optimization');
const CACHE_DIR = path.join(process.cwd(), 'uploads', 'images', 'cache');

const ALLOWED_DIMENSIONS = [64, 128, 256, 320, 480, 640, 800, 1024, 1280, 1600, 1920];
const MAX_CACHE_BYTES = Number(process.env.IMAGE_CACHE_MAX_BYTES) || 512 * 1024 * 1024;
const MAX_CACHE_AGE_MS = Number(process.env.IMAGE_CACHE_MAX_AGE_MS) || 30 * 24 * 60 * 60 * 1000;

/** Snap a caller-supplied dimension up to the nearest configured size to bound cache variants. */
function snapDimension(value?: number): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return ALLOWED_DIMENSIONS.find((d) => d >= value) ?? ALLOWED_DIMENSIONS[ALLOWED_DIMENSIONS.length - 1];
}

function snapQuality(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) return 80;
  return Math.min(100, Math.max(5, Math.round(value / 5) * 5));
}

const VALID_FORMATS = ['webp', 'jpeg', 'png'] as const;

function isValidImageFormat(value: unknown): value is 'webp' | 'jpeg' | 'png' {
  return typeof value === 'string' && (VALID_FORMATS as readonly string[]).includes(value);
}

interface OptimizationOptions {
  width?: number;
  height?: number;
  quality?: number;
  format?: 'webp' | 'jpeg' | 'png';
}

export const ImageOptimizationService = {
  /**
   * Initialize cache directory
   */
  init: async (): Promise<void> => {
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create cache directory:', error);
    }
  },

  /**
   * Generate cache key from file path and options
   */
  getCacheKey: (
    filePath: string,
    options: OptimizationOptions,
    stat?: { mtimeMs: number; size: number },
  ): string => {
    const canonical = [
      filePath,
      stat ? Math.floor(stat.mtimeMs) : '',
      stat ? stat.size : '',
      options.width ?? '',
      options.height ?? '',
      options.quality ?? '',
      options.format ?? '',
    ].join('|');
    return crypto.createHash('sha256').update(canonical).digest('hex');
  },

  /**
   * Get cached file path
   */
  getCachePath: (cacheKey: string, format: string): string => {
    return path.join(CACHE_DIR, `${cacheKey}.${format}`);
  },

  /**
   * Optimize image to WebP with optional resizing
   */
  optimizeToWebP: async (inputPath: string, options: OptimizationOptions = {}): Promise<Buffer> => {
    const { width, height, quality = 80 } = options;

    let transform = sharp(inputPath);

    if (width || height) {
      transform = transform.resize(width, height, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    return transform.webp({ quality }).toBuffer();
  },

  /**
   * Optimize image with caching
   */
  optimize: async (
    inputPath: string,
    options: OptimizationOptions = {},
  ): Promise<{ buffer: Buffer; format: string; cacheKey: string; etag: string }> => {
    if (options.format !== undefined && !isValidImageFormat(options.format)) {
      throw new BadRequestError(
        `Invalid image format "${options.format}". Allowed formats: webp, jpeg, png`,
      );
    }

    options = {
      ...options,
      width: snapDimension(options.width),
      height: snapDimension(options.height),
      quality: snapQuality(options.quality),
    };
    const format = options.format || 'webp';
    let stat: { mtimeMs: number; size: number } | undefined;
    try {
      const st = await fs.stat(inputPath);
      if (st && typeof st.mtimeMs === 'number') stat = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      // Let sharp surface missing-file errors
    }
    const cacheKey = ImageOptimizationService.getCacheKey(inputPath, options, stat);
    const cachePath = ImageOptimizationService.getCachePath(cacheKey, format);

    // Check cache
    try {
      const cached = await fs.readFile(cachePath);
      const now = new Date();
      fs.utimes(cachePath, now, now).catch(() => undefined);
      const etag = `"${crypto.createHash('sha256').update(cached).digest('hex')}"`;
      return { buffer: cached, format, cacheKey, etag };
    } catch {
      // Cache miss, proceed with optimization
    }

    // Optimize
    const { width, height, quality = 80 } = options;
    let transform = sharp(inputPath);

    if (width || height) {
      transform = transform.resize(width, height, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    let buffer: Buffer;
    if (format === 'webp') {
      buffer = await transform.webp({ quality }).toBuffer();
    } else if (format === 'jpeg') {
      buffer = await transform.jpeg({ quality }).toBuffer();
    } else if (format === 'png') {
      buffer = await transform.png({ compressionLevel: 9 }).toBuffer();
    } else {
      buffer = await transform.toBuffer();
    }

    // Cache result
    try {
      await fs.writeFile(cachePath, buffer);
    } catch (error) {
      logger.error('Failed to cache optimized image:', error);
    }
    ImageOptimizationService.evict().catch(() => undefined);

    const etag = `"${crypto.createHash('sha256').update(buffer).digest('hex')}"`;
    return { buffer, format, cacheKey, etag };
  },

  /**
   * Evict cache entries older than the max age, then least-recently-used until under the byte budget
   */
  evict: async (maxBytes = MAX_CACHE_BYTES, maxAgeMs = MAX_CACHE_AGE_MS): Promise<number> => {
    let removed = 0;
    try {
      const names = await fs.readdir(CACHE_DIR);
      const entries = (
        await Promise.all(
          names.map(async (name) => {
            const file = path.join(CACHE_DIR, name);
            try {
              const st = await fs.stat(file);
              return { file, size: st.size, used: Math.max(st.atimeMs, st.mtimeMs) };
            } catch {
              return null;
            }
          }),
        )
      ).filter((e): e is { file: string; size: number; used: number } => e !== null);

      const now = Date.now();
      let total = entries.reduce((sum, e) => sum + e.size, 0);
      entries.sort((x, y) => x.used - y.used);
      for (const e of entries) {
        if (total <= maxBytes && now - e.used <= maxAgeMs) break;
        await fs.unlink(e.file).catch(() => undefined);
        total -= e.size;
        removed++;
      }
    } catch (error) {
      logger.error('Failed to evict image cache:', error);
    }
    return removed;
  },

  /**
   * Get image metadata
   */
  getMetadata: async (inputPath: string) => {
    return sharp(inputPath).metadata();
  },

  /**
   * Batch optimize images
   */
  optimizeBatch: async (
    inputPaths: string[],
    options: OptimizationOptions = {},
  ): Promise<Array<{ path: string; buffer: Buffer; format: string }>> => {
    return Promise.all(
      inputPaths.map(async (inputPath) => {
        const { buffer, format } = await ImageOptimizationService.optimize(inputPath, options);
        return { path: inputPath, buffer, format };
      }),
    );
  },

  /**
   * Clear cache
   */
  clearCache: async (): Promise<void> => {
    try {
      const files = await fs.readdir(CACHE_DIR);
      await Promise.all(files.map((file) => fs.unlink(path.join(CACHE_DIR, file))));
    } catch (error) {
      logger.error('Failed to clear cache:', error);
    }
  },

  /**
   * Get cache size in bytes
   */
  getCacheSize: async (): Promise<number> => {
    try {
      const files = await fs.readdir(CACHE_DIR);
      const sizes = await Promise.all(
        files.map(async (file) => {
          const stat = await fs.stat(path.join(CACHE_DIR, file));
          return stat.size;
        }),
      );
      return sizes.reduce((a, b) => a + b, 0);
    } catch {
      return 0;
    }
  },
};
