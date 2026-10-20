import multer from 'multer';
import crypto from 'crypto';
import path from 'path';

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/mpeg': '.mpeg',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/webm': '.webm',
};

export function extensionForMime(mimetype: string): string {
  return MIME_EXTENSIONS[mimetype] ?? '.bin';
}

export function generateUploadFilename(fieldname: string, mimetype: string): string {
  const safeField = fieldname.replace(/[^a-zA-Z0-9_-]/g, '') || 'file';
  return `${safeField}-${crypto.randomUUID()}${extensionForMime(mimetype)}`;
}

/** Shared multer disk storage: UUID filenames with an extension derived from the MIME type. */
export function createUploadStorage(subdir: string): multer.StorageEngine {
  return multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, path.join(process.cwd(), 'uploads', subdir));
    },
    filename: (_req, file, cb) => {
      cb(null, generateUploadFilename(file.fieldname, file.mimetype));
    },
  });
}
