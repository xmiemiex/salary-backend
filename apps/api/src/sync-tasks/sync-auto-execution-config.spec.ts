import { readSyncAutoExecutionConfig, retryDelaySeconds } from './sync-auto-execution-config';

describe('sync auto execution configuration', () => {
  it('is safely disabled by default', () => {
    expect(readSyncAutoExecutionConfig({})).toEqual({ enabled: false, pollSeconds: 60, batchSize: 2, maxAttempts: 3, leaseSeconds: 900, retryBaseSeconds: 300 });
  });
  it.each([
    [{ SYNC_AUTO_EXECUTION_ENABLED: 'yes' }, 'SYNC_AUTO_EXECUTION_ENABLED'],
    [{ SYNC_AUTO_EXECUTION_POLL_SECONDS: '0' }, 'SYNC_AUTO_EXECUTION_POLL_SECONDS'],
    [{ SYNC_AUTO_EXECUTION_BATCH_SIZE: '11' }, 'SYNC_AUTO_EXECUTION_BATCH_SIZE'],
    [{ SYNC_AUTO_EXECUTION_MAX_ATTEMPTS: '6' }, 'SYNC_AUTO_EXECUTION_MAX_ATTEMPTS'],
    [{ SYNC_AUTO_EXECUTION_LEASE_SECONDS: '60' }, 'SYNC_AUTO_EXECUTION_LEASE_SECONDS'],
    [{ SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS: '0' }, 'SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS'],
  ])('rejects invalid configuration %#', (env, name) => expect(() => readSyncAutoExecutionConfig(env)).toThrow(name));
  it('uses bounded exponential retry delays', () => {
    expect(retryDelaySeconds(300, 1)).toBe(300);
    expect(retryDelaySeconds(300, 3)).toBe(1200);
    expect(retryDelaySeconds(86400, 5)).toBe(86400);
  });
});
