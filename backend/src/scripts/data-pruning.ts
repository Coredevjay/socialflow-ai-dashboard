import { runDataPruning, type DataPruningOptions } from '../retention/dataPruningService';
import { createLogger } from '../lib/logger';

const logger = createLogger('data-pruning');

interface ParsedArgs {
  dryRun: boolean;
  options: DataPruningOptions;
}

const parseBoolean = (value: string | undefined): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
};

const parseNumber = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseArgs = (argv: string[], env: NodeJS.ProcessEnv): ParsedArgs => {
  const options: DataPruningOptions = {};
  let dryRun = parseBoolean(env.DATA_PRUNING_DRY_RUN) ?? false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    const takeValue = (): string | undefined => {
      if (next !== undefined && !next.startsWith('--')) {
        i += 1;
        return next;
      }
      return undefined;
    };

    switch (arg) {
      case '--dry-run': {
        dryRun = true;
        break;
      }
      case '--no-dry-run': {
        dryRun = false;
        break;
      }
      case '--retention-days': {
        const value = parseNumber(takeValue());
        if (value !== undefined) {
          options.retentionDays = value;
        }
        break;
      }
      case '--base-path':
      case '--data-dir': {
        const value = takeValue();
        if (value !== undefined) {
          options.basePath = value;
        }
        break;
      }
      case '--batch-size': {
        const value = parseNumber(takeValue());
        if (value !== undefined) {
          options.batchSize = value;
        }
        break;
      }
      default: {
        if (arg.startsWith('--retention-days=')) {
          const value = parseNumber(arg.slice('--retention-days='.length));
          if (value !== undefined) {
            options.retentionDays = value;
          }
        } else if (arg.startsWith('--base-path=') || arg.startsWith('--data-dir=')) {
          const value = arg.slice(arg.indexOf('=') + 1);
          if (value !== '') {
            options.basePath = value;
          }
        } else if (arg.startsWith('--batch-size=')) {
          const value = parseNumber(arg.slice('--batch-size='.length));
          if (value !== undefined) {
            options.batchSize = value;
          }
        }
        break;
      }
    }
  }

  // Environment fallbacks for config overrides.
  if (options.retentionDays === undefined) {
    const value = parseNumber(env.DATA_PRUNING_RETENTION_DAYS);
    if (value !== undefined) {
      options.retentionDays = value;
    }
  }
  if (options.basePath === undefined) {
    const value = env.DATA_PRUNING_BASE_PATH ?? env.DATA_PRUNING_DATA_DIR;
    if (value !== undefined && value.trim() !== '') {
      options.basePath = value;
    }
  }
  if (options.batchSize === undefined) {
    const value = parseNumber(env.DATA_PRUNING_BATCH_SIZE);
    if (value !== undefined) {
      options.batchSize = value;
    }
  }

  return { dryRun, options };
};

const main = async (): Promise<void> => {
  const { dryRun, options } = parseArgs(process.argv.slice(2), process.env);
  logger.info('Starting', { dryRun, options });
  const summary = await runDataPruning({ ...options, dryRun });
  logger.info('Completed', { dryRun, summary });
};

void main().catch((error) => {
  logger.error('Failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});