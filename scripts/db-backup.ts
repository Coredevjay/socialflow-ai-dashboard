#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync, openSync, closeSync } from 'fs';
import { join } from 'path';

const DB_URL = process.env.DATABASE_URL;
const S3_BUCKET = process.env.S3_BACKUP_BUCKET;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 30);
const BACKUP_PREFIX = 'backups/db-backup-';

if (!DB_URL || !S3_BUCKET) {
  console.error('DATABASE_URL and S3_BACKUP_BUCKET env vars required');
  process.exit(1);
}

if (!Number.isInteger(RETENTION_DAYS) || RETENTION_DAYS < 1) {
  console.error('BACKUP_RETENTION_DAYS must be a positive integer');
  process.exit(1);
}

const s3 = new S3Client({ region: AWS_REGION });
// Full timestamp (with time of day) so multiple runs on the same day never collide
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = `/tmp/db-backup-${timestamp}.sql`;
const s3Key = `${BACKUP_PREFIX}${timestamp}.sql`;

async function backup() {
  try {
    console.log('Starting database backup...');
    const outFd = openSync(backupFile, 'w');
    try {
      const result = spawnSync('pg_dump', [DB_URL], { stdio: ['ignore', outFd, 'inherit'] });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`pg_dump exited with status ${result.status}`);
      }
    } finally {
      closeSync(outFd);
    }

    console.log('Uploading to S3...');
    const fileContent = readFileSync(backupFile);
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: fileContent,
      })
    );

    console.log(`Backup uploaded: s3://${S3_BUCKET}/${s3Key}`);

    await cleanupOldBackups();
    console.log('Backup complete');
  } catch (err) {
    console.error('Backup failed:', err);
    process.exit(1);
  }
}

async function cleanupOldBackups() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

  let ContinuationToken: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: BACKUP_PREFIX,
        ContinuationToken,
      })
    );

    for (const obj of page.Contents ?? []) {
      // Only delete keys this script created, never other objects under backups/
      if (!obj.Key?.startsWith(BACKUP_PREFIX) || !obj.Key.endsWith('.sql')) continue;
      if (obj.LastModified && obj.LastModified < cutoffDate) {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: S3_BUCKET,
            Key: obj.Key,
          })
        );
        console.log(`Deleted old backup: ${obj.Key}`);
      }
    }

    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
}

backup();
