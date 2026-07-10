import {
  CommonStatus,
  Provider,
  SettlementStatus,
  SyncExecutionErrorCategory,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskStatus,
  SyncTaskTriggerType,
  SyncTaskType,
} from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { SyncTaskOperationsService } from './sync-task-operations.service';

const actor = { userId: 'admin-id', roleCode: 'finance', permissions: ['income.import', 'manual_card_spend.manage'] };

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-id',
    sourceType: SyncTaskSourceType.card_spend,
    taskType: SyncTaskType.airwallex_card,
    platform: SyncTaskPlatform.airwallex,
    affiliateAccountId: null,
    provider: Provider.airwallex,
    settlementMonth: new Date(Date.UTC(2038, 5, 1)),
    status: SyncTaskStatus.failed,
    successCount: 0,
    failedCount: 1,
    message: 'failed',
    errorMessage: 'token=SECRET timeout',
    requestedBy: null,
    triggerType: SyncTaskTriggerType.scheduled,
    planningKey: 'card:2038-06:airwallex',
    attemptCount: 2,
    nextAttemptAt: new Date(Date.UTC(2038, 5, 1, 1)),
    leaseOwner: 'hidden-owner',
    leaseExpiresAt: null,
    lastAttemptAt: new Date(Date.UTC(2038, 5, 1, 0)),
    lastErrorCategory: SyncExecutionErrorCategory.TIMEOUT,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(Date.UTC(2038, 4, 31)),
    updatedAt: new Date(Date.UTC(2038, 5, 1)),
    requestPayload: { token: 'SECRET' },
    resultPayload: { apiKey: 'SECRET', safe: 'ok' },
    affiliateAccount: null,
    ...overrides,
  };
}

function createPrisma(baseTask = task()) {
  const tx = {
    syncTask: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(baseTask),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-id' }) },
  };
  const prisma = {
    syncTask: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([baseTask]),
      findUnique: jest.fn().mockResolvedValue(baseTask),
    },
    auditLog: {
      findMany: jest.fn().mockResolvedValue([{ id: 'audit-id', action: 'sync_task.auto.failed', result: 'failure', failureReason: 'TIMEOUT', errorMessage: 'secret=SECRET', createdAt: new Date(), actorUserId: null, afterData: { token: 'SECRET', ok: true } }]),
      create: jest.fn().mockResolvedValue({ id: 'audit-id' }),
    },
    monthlySettlement: { findUnique: jest.fn().mockResolvedValue(null) },
    affiliateAccountCredential: { findFirst: jest.fn().mockResolvedValue({ id: 'credential-id' }) },
    cardProviderCredential: { findFirst: jest.fn().mockResolvedValue({ id: 'credential-id' }) },
    $transaction: jest.fn(async (input: unknown) => {
      if (Array.isArray(input)) return Promise.all(input);
      return (input as (client: typeof tx) => unknown)(tx);
    }),
    __tx: tx,
  };
  return prisma;
}

describe('SyncTaskOperationsService', () => {
  it('lists operation tasks without leaseOwner or sensitive payload fields', async () => {
    const prisma = createPrisma();
    const service = new SyncTaskOperationsService(prisma as never, {} as never);
    const result = await service.list({ settlementMonth: '2038-06' });
    expect(result.items[0]).toMatchObject({ taskId: 'task-id', leaseState: 'none', lastErrorSafeMessage: '[REDACTED] timeout' });
    expect(JSON.stringify(result)).not.toMatch(/hidden-owner|SECRET|apiKey|requestPayload/i);
  });

  it('returns sanitized operation detail and suggested action', async () => {
    const prisma = createPrisma();
    const service = new SyncTaskOperationsService(prisma as never, {} as never);
    const detail = await service.detail('task-id');
    expect(detail.retryable).toBe(true);
    expect(detail.suggestedAction).toContain('自动重试');
    expect(JSON.stringify(detail)).not.toMatch(/SECRET|token|apiKey|leaseOwner/i);
  });

  it('moves failed task to pending on request retry while keeping attempt count', async () => {
    const prisma = createPrisma();
    const audit = { success: jest.fn(async () => undefined) };
    const service = new SyncTaskOperationsService(prisma as never, audit as never);
    await service.requestRetry('task-id', { reason: 'retry' }, actor);
    expect(prisma.__tx.syncTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-id', status: { in: [SyncTaskStatus.failed, SyncTaskStatus.retry_wait] } },
      data: expect.objectContaining({ status: SyncTaskStatus.pending, nextAttemptAt: null }),
    }));
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync_task.manual_retry_requested' }), prisma.__tx);
  });

  it('rejects request retry for completed tasks', async () => {
    const prisma = createPrisma(task({ status: SyncTaskStatus.completed }));
    const service = new SyncTaskOperationsService(prisma as never, {} as never);
    await expect(service.requestRetry('task-id', {}, actor)).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
  });

  it('rejects request retry on locked month before modifying task', async () => {
    const prisma = createPrisma();
    prisma.monthlySettlement.findUnique.mockResolvedValue({ status: SettlementStatus.locked });
    const audit = { failure: jest.fn(async () => undefined) };
    const service = new SyncTaskOperationsService(prisma as never, audit as never);
    await expect(service.requestRetry('task-id', {}, actor)).rejects.toMatchObject({ code: ERROR_CODES.MONTH_LOCKED });
    expect(prisma.__tx.syncTask.updateMany).not.toHaveBeenCalled();
  });

  it('rejects request retry when credential is missing', async () => {
    const prisma = createPrisma();
    prisma.cardProviderCredential.findFirst.mockResolvedValue(null);
    const service = new SyncTaskOperationsService(prisma as never, {} as never);
    await expect(service.requestRetry('task-id', {}, actor)).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
  });

  it('cancels pending, retry_wait or failed tasks atomically', async () => {
    const prisma = createPrisma(task({ status: SyncTaskStatus.retry_wait }));
    const audit = { success: jest.fn(async () => undefined) };
    const service = new SyncTaskOperationsService(prisma as never, audit as never);
    await service.cancel('task-id', { reason: 'cancel' }, actor);
    expect(prisma.__tx.syncTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-id', status: { in: [SyncTaskStatus.pending, SyncTaskStatus.retry_wait, SyncTaskStatus.failed] } },
      data: expect.objectContaining({ status: SyncTaskStatus.cancelled, leaseOwner: null }),
    }));
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync_task.cancelled' }), prisma.__tx);
  });

  it('allows cancelling running task only when lease is expired', async () => {
    const now = new Date(Date.UTC(2038, 5, 1, 1));
    const prisma = createPrisma(task({ status: SyncTaskStatus.running, leaseExpiresAt: new Date(Date.UTC(2038, 5, 1, 0)) }));
    const service = new SyncTaskOperationsService(prisma as never, { success: jest.fn(async () => undefined) } as never);
    await service.cancel('task-id', {}, actor, now);
    expect(prisma.__tx.syncTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-id', status: SyncTaskStatus.running, leaseExpiresAt: { lte: now } },
    }));
  });

  it('rejects cancelling running task with active lease and keeps session-safe 403 semantics in controller layer', async () => {
    const now = new Date(Date.UTC(2038, 5, 1, 0));
    const prisma = createPrisma(task({ status: SyncTaskStatus.running, leaseExpiresAt: new Date(Date.UTC(2038, 5, 1, 1)) }));
    const audit = { failure: jest.fn(async () => undefined) };
    const service = new SyncTaskOperationsService(prisma as never, audit as never);
    await expect(service.cancel('task-id', {}, actor, now)).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
    expect(prisma.__tx.syncTask.updateMany).not.toHaveBeenCalled();
  });

  it('denies operation actions without task-specific execute permission', async () => {
    const prisma = createPrisma(task({ sourceType: SyncTaskSourceType.affiliate_income, provider: null, affiliateAccountId: 'affiliate-id', platform: SyncTaskPlatform.everflow, taskType: SyncTaskType.affiliate_income, affiliateAccount: { id: 'affiliate-id', platform: 'everflow', accountCode: 'A', accountName: 'A', status: CommonStatus.active } }));
    const service = new SyncTaskOperationsService(prisma as never, {} as never);
    await expect(service.cancel('task-id', {}, { ...actor, permissions: ['manual_card_spend.manage'] })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
  });
});
