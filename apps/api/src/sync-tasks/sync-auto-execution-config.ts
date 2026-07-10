export type SyncAutoExecutionConfig = {
  enabled: boolean;
  pollSeconds: number;
  batchSize: number;
  maxAttempts: number;
  leaseSeconds: number;
  retryBaseSeconds: number;
};

export function readSyncAutoExecutionConfig(env: NodeJS.ProcessEnv = process.env): SyncAutoExecutionConfig {
  const enabledText = env.SYNC_AUTO_EXECUTION_ENABLED ?? 'false';
  if (enabledText !== 'true' && enabledText !== 'false') {
    throw new Error('SYNC_AUTO_EXECUTION_ENABLED must be true or false.');
  }
  const pollSeconds = parseInteger(env.SYNC_AUTO_EXECUTION_POLL_SECONDS ?? '60', 'SYNC_AUTO_EXECUTION_POLL_SECONDS', 1, 3600);
  const batchSize = parseInteger(env.SYNC_AUTO_EXECUTION_BATCH_SIZE ?? '2', 'SYNC_AUTO_EXECUTION_BATCH_SIZE', 1, 10);
  const maxAttempts = parseInteger(env.SYNC_AUTO_EXECUTION_MAX_ATTEMPTS ?? '3', 'SYNC_AUTO_EXECUTION_MAX_ATTEMPTS', 1, 5);
  const leaseSeconds = parseInteger(env.SYNC_AUTO_EXECUTION_LEASE_SECONDS ?? '900', 'SYNC_AUTO_EXECUTION_LEASE_SECONDS', 2, 86400);
  const retryBaseSeconds = parseInteger(env.SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS ?? '300', 'SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS', 1, 86400);
  if (leaseSeconds <= pollSeconds) {
    throw new Error('SYNC_AUTO_EXECUTION_LEASE_SECONDS must be greater than SYNC_AUTO_EXECUTION_POLL_SECONDS.');
  }
  return { enabled: enabledText === 'true', pollSeconds, batchSize, maxAttempts, leaseSeconds, retryBaseSeconds };
}

function parseInteger(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return parsed;
}

export function retryDelaySeconds(baseSeconds: number, attemptCount: number): number {
  return Math.min(baseSeconds * 2 ** Math.max(0, attemptCount - 1), 86400);
}
