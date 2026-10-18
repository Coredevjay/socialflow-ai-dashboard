#!/usr/bin/env node

import { spawn } from 'child_process';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { join } from 'path';

const DB_URL = process.env.DATABASE_URL;
const S3_BUCKET = process.env.S3_BACKUP_BUCKET;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const RETENTION_DAYS = 30;

if (!DB_URL || !S3_BUCKET) {
  console.error('DATABASE_URL and S3_BACKUP_BUCKET env vars required');
  process.exit(1);
}

// Keep the password out of argv (visible via ps / /proc/<pid>/cmdline) by
// handing it to pg_dump through PGPASSWORD instead of the connection string.
const dbUrl = new URL(DB_URL);
const dbPassword = decodeURIComponent(dbUrl.password);
dbUrl.password = '';
const pgDumpEnv = dbPassword ? { ...process.env, PGPASSWORD: dbPassword } : process.env;

const s3 = new S3Client({ region: AWS_REGION });
const timestamp = new Date().toISOString().split('T')[0];
const s3Key = `backups/db-backup-${timestamp}.sql`;

async function backup() {
  try {
    console.log('Starting database backup...');
    // Stream pg_dump's stdout straight into a multipart upload so the dump is
    // never held in memory or written to local disk.
    const pgDump = spawn('pg_dump', [dbUrl.toString()], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: pgDumpEnv,
    });
    const abortController = new AbortController();
    const dumpDone = new Promise<void>((resolve, reject) => {
      const fail = (err: Error) => {
        // Abort the multipart upload so a truncated dump is never completed.
        abortController.abort(err);
        reject(err);
      };
      pgDump.on('error', fail);
      pgDump.on('exit', (code) => {
        if (code === 0) resolve();
        else fail(new Error(`pg_dump exited with status ${code}`));
      });
    });

    console.log('Uploading to S3...');
    const upload = new Upload({
      client: s3,
      abortController,
      params: {
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: pgDump.stdout,
        ServerSideEncryption: 'aws:kms',
      },
    });
    await Promise.all([upload.done(), dumpDone]);

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

  const { Contents } = await s3.send(
    new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: 'backups/',
    })
  );

  if (!Contents) return;

  for (const obj of Contents) {
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
}

backup();
