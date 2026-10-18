#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync, openSync, closeSync } from 'fs';
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
const backupFile = `/tmp/db-backup-${timestamp}.sql`;
const s3Key = `backups/db-backup-${timestamp}.sql`;

async function backup() {
  try {
    console.log('Starting database backup...');
    const outFd = openSync(backupFile, 'w');
    try {
      const result = spawnSync('pg_dump', [dbUrl.toString()], {
        stdio: ['ignore', outFd, 'inherit'],
        env: pgDumpEnv,
      });
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
