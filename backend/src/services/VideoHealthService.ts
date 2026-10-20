import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const FFMPEG_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class VideoHealthService {
  private ffmpegCache: CacheEntry<{ available: boolean; version?: string; error?: string }> | null =
    null;
  private codecsCache: CacheEntry<{ codecs: Record<string, boolean> }> | null = null;

  /**
   * Check if FFmpeg is installed and accessible
   */
  public async checkFFmpeg(): Promise<{ available: boolean; version?: string; error?: string }> {
    const cached = this.ffmpegCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    let result: { available: boolean; version?: string; error?: string };
    try {
      const { stdout } = await execFileAsync('ffmpeg', ['-version'], {
        timeout: FFMPEG_TIMEOUT_MS,
      });
      const versionMatch = stdout.match(/ffmpeg version ([^\s]+)/);
      const version = versionMatch ? versionMatch[1] : 'unknown';

      result = {
        available: true,
        version,
      };
    } catch (error) {
      result = {
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    this.ffmpegCache = { value: result, expiresAt: Date.now() + CACHE_TTL_MS };
    return result;
  }

  /**
   * Check if required codecs are available
   */
  public async checkCodecs(): Promise<{ codecs: Record<string, boolean> }> {
    const cached = this.codecsCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const requiredCodecs = ['libx264', 'libvpx-vp9', 'aac', 'libopus'];
    const codecs: Record<string, boolean> = {};

    try {
      const { stdout } = await execFileAsync('ffmpeg', ['-codecs'], {
        timeout: FFMPEG_TIMEOUT_MS,
      });

      for (const codec of requiredCodecs) {
        codecs[codec] = stdout.includes(codec);
      }
    } catch (error) {
      // If ffmpeg -codecs fails, mark all as unavailable
      for (const codec of requiredCodecs) {
        codecs[codec] = false;
      }
    }

    const result = { codecs };
    this.codecsCache = { value: result, expiresAt: Date.now() + CACHE_TTL_MS };
    return result;
  }

  /**
   * Get comprehensive video service health status
   */
  public async getHealthStatus() {
    const [ffmpegStatus, codecStatus] = await Promise.all([this.checkFFmpeg(), this.checkCodecs()]);

    const isHealthy =
      ffmpegStatus.available && Object.values(codecStatus.codecs).every((available) => available);

    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      ffmpeg: ffmpegStatus,
      codecs: codecStatus.codecs,
      timestamp: new Date().toISOString(),
    };
  }
}

export const videoHealthService = new VideoHealthService();
