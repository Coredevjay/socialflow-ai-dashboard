import { videoHealthService } from '../VideoHealthService';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('util', () => ({ promisify: (fn: unknown) => fn }));

const { execFile } = jest.requireMock('child_process') as { execFile: jest.Mock };

function mockExecFile(err: Error | null, result?: { stdout: string; stderr: string }) {
  execFile.mockImplementation(
    (_file: string, _args: string[], _opts: object, cb: (e: Error | null, r?: object) => void) =>
      cb(err, result),
  );
}

describe('VideoHealthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    videoHealthService.clearCache();
  });

  describe('checkFFmpeg', () => {
    it('returns available=true and version when ffmpeg is present', async () => {
      mockExecFile(null, { stdout: 'ffmpeg version 6.0 Copyright', stderr: '' });
      const result = await videoHealthService.checkFFmpeg();
      expect(result.available).toBe(true);
      expect(result.version).toBe('6.0');
    });

    it('returns available=true with version=unknown when version line is missing', async () => {
      mockExecFile(null, { stdout: 'some output without version', stderr: '' });
      const result = await videoHealthService.checkFFmpeg();
      expect(result.available).toBe(true);
      expect(result.version).toBe('unknown');
    });

    it('returns available=false with error message when ffmpeg is not found', async () => {
      mockExecFile(new Error('ffmpeg: command not found'));
      const result = await videoHealthService.checkFFmpeg();
      expect(result.available).toBe(false);
      expect(result.error).toBe('ffmpeg: command not found');
    });

    it('uses execFile with a 3000ms timeout and no shell', async () => {
      mockExecFile(null, { stdout: 'ffmpeg version 6.0', stderr: '' });
      await videoHealthService.checkFFmpeg();
      expect(execFile).toHaveBeenCalledTimes(1);
      const [file, args, opts] = execFile.mock.calls[0];
      expect(file).toBe('ffmpeg');
      expect(args).toEqual(['-version']);
      expect(opts).toMatchObject({ timeout: 3000 });
    });

    it('caches the result so ffmpeg is not re-spawned within the TTL', async () => {
      mockExecFile(null, { stdout: 'ffmpeg version 6.0', stderr: '' });
      await videoHealthService.checkFFmpeg();
      await videoHealthService.checkFFmpeg();
      await videoHealthService.checkFFmpeg();
      expect(execFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkCodecs', () => {
    it('marks codecs as available when present in output', async () => {
      const stdout = 'libx264 libvpx-vp9 aac libopus';
      mockExecFile(null, { stdout, stderr: '' });
      const { codecs } = await videoHealthService.checkCodecs();
      expect(codecs['libx264']).toBe(true);
      expect(codecs['libvpx-vp9']).toBe(true);
      expect(codecs['aac']).toBe(true);
      expect(codecs['libopus']).toBe(true);
    });

    it('marks a codec as unavailable when absent from output', async () => {
      mockExecFile(null, { stdout: 'libx264 aac libopus', stderr: '' });
      const { codecs } = await videoHealthService.checkCodecs();
      expect(codecs['libvpx-vp9']).toBe(false);
    });

    it('marks all codecs unavailable when ffmpeg -codecs fails', async () => {
      mockExecFile(new Error('exec error'));
      const { codecs } = await videoHealthService.checkCodecs();
      for (const val of Object.values(codecs)) {
        expect(val).toBe(false);
      }
    });

    it('uses execFile with a 3000ms timeout and caches the result', async () => {
      mockExecFile(null, { stdout: 'libx264 libvpx-vp9 aac libopus', stderr: '' });
      await videoHealthService.checkCodecs();
      await videoHealthService.checkCodecs();
      expect(execFile).toHaveBeenCalledTimes(1);
      const [file, args, opts] = execFile.mock.calls[0];
      expect(file).toBe('ffmpeg');
      expect(args).toEqual(['-codecs']);
      expect(opts).toMatchObject({ timeout: 3000 });
    });
  });

  describe('getHealthStatus', () => {
    it('returns status=healthy when ffmpeg is available and all codecs present', async () => {
      const stdout = 'ffmpeg version 6.0\nlibx264 libvpx-vp9 aac libopus';
      execFile.mockImplementation(
        (_file: string, _args: string[], _opts: object, cb: (e: null, r: object) => void) =>
          cb(null, { stdout, stderr: '' }),
      );
      const status = await videoHealthService.getHealthStatus();
      expect(status.status).toBe('healthy');
      expect(status.ffmpeg.available).toBe(true);
    });

    it('returns status=unhealthy when ffmpeg is unavailable', async () => {
      execFile.mockImplementation(
        (_file: string, _args: string[], _opts: object, cb: (e: Error) => void) =>
          cb(new Error('not found')),
      );
      const status = await videoHealthService.getHealthStatus();
      expect(status.status).toBe('unhealthy');
    });

    it('returns status=unhealthy when a codec is missing', async () => {
      // First execFile (ffmpeg -version) succeeds, second (ffmpeg -codecs) has missing codec
      execFile
        .mockImplementationOnce(
          (_file: string, _args: string[], _opts: object, cb: (e: null, r: object) => void) =>
            cb(null, { stdout: 'ffmpeg version 6.0', stderr: '' }),
        )
        .mockImplementationOnce(
          (_file: string, _args: string[], _opts: object, cb: (e: null, r: object) => void) =>
            cb(null, { stdout: 'libx264 aac libopus', stderr: '' }), // libvpx-vp9 missing
        );
      const status = await videoHealthService.getHealthStatus();
      expect(status.status).toBe('unhealthy');
    });

    it('includes a timestamp in ISO format', async () => {
      const stdout = 'ffmpeg version 6.0\nlibx264 libvpx-vp9 aac libopus';
      execFile.mockImplementation(
        (_file: string, _args: string[], _opts: object, cb: (e: null, r: object) => void) =>
          cb(null, { stdout, stderr: '' }),
      );
      const status = await videoHealthService.getHealthStatus();
      expect(() => new Date(status.timestamp)).not.toThrow();
    });
  });
});
