import { AppError } from '../common/app-error';
import { ERROR_CODES } from '@salary/shared';
import { CommonStatus, Provider, SyncTaskPlatform, SyncTaskSourceType, SyncTaskStatus, SyncTaskType } from '@prisma/client';
import { SYNC_ADAPTER_NOT_IMPLEMENTED_ERROR } from './sync-adapter';
import { SyncAdapterResolver } from './sync-adapter-resolver';
import { SyncTaskExecutionService } from './sync-task-execution.service';
import { SyncTasksService } from './sync-tasks.service';

const actor = {
  userId: '00000000-0000-0000-0000-000000000001',
  roleCode: 'finance',
  permissions: ['income.import', 'manual_card_spend.manage'],
  ipAddress: '127.0.0.1',
  userAgent: 'jest',
};

describe('SyncTasksService', () => {
  let prisma: {
    affiliateAccount: { findUnique: jest.Mock };
    syncTask: { create: jest.Mock; count: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let monthLock: { assertWritable: jest.Mock };
  let audit: { success: jest.Mock; failure: jest.Mock };
  let service: SyncTasksService;

  beforeEach(() => {
    prisma = {
      affiliateAccount: { findUnique: jest.fn() },
      syncTask: {
        create: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      },
      $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    };
    monthLock = { assertWritable: jest.fn().mockResolvedValue(undefined) };
    audit = {
      success: jest.fn().mockResolvedValue({ id: 'audit-success' }),
      failure: jest.fn().mockResolvedValue({ id: 'audit-failure' }),
    };
    service = new SyncTasksService(prisma as never, monthLock as never, audit as never);
  });

  it('requires affiliateAccountId for affiliate_income task creation and writes failure audit', async () => {
    await expect(
      service.createAffiliateIncome({ settlementMonth: '2026-06', affiliateAccountId: '' }, actor),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    expect(prisma.syncTask.create).not.toHaveBeenCalled();
    expect(audit.failure).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sync_task.create.affiliate_income',
        objectType: 'sync_tasks',
        failureReason: ERROR_CODES.VALIDATION_ERROR,
      }),
    );
  });

  it('uses everflow from affiliateAccount.platform', async () => {
    prisma.affiliateAccount.findUnique.mockResolvedValue(affiliateAccount('everflow'));
    prisma.syncTask.create.mockResolvedValue(syncTask({ platform: SyncTaskPlatform.everflow, status: SyncTaskStatus.pending }));

    const task = await service.createAffiliateIncome(
      { settlementMonth: '2026-06', affiliateAccountId: '10000000-0000-0000-0000-000000000001' },
      actor,
    );

    expect(prisma.syncTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceType: SyncTaskSourceType.affiliate_income,
          taskType: SyncTaskType.affiliate_income,
          platform: SyncTaskPlatform.everflow,
          status: SyncTaskStatus.pending,
          message: null,
        }),
      }),
    );
    expect(task.platform).toBe(SyncTaskPlatform.everflow);
    expect(task.status).toBe(SyncTaskStatus.pending);
    expect(task.status).not.toBe('completed');
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync_task.create.affiliate_income' }));
  });

  it('uses cake from affiliateAccount.platform', async () => {
    prisma.affiliateAccount.findUnique.mockResolvedValue(affiliateAccount('cake'));
    prisma.syncTask.create.mockResolvedValue(syncTask({ platform: SyncTaskPlatform.cake }));

    const task = await service.createAffiliateIncome(
      { settlementMonth: '2026-06-18', affiliateAccountId: '10000000-0000-0000-0000-000000000001' },
      actor,
    );

    expect(prisma.syncTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ platform: SyncTaskPlatform.cake }),
      }),
    );
    expect(task.platform).toBe(SyncTaskPlatform.cake);
  });

  it('rejects affiliateAccount.platform that is not everflow or cake and writes failure audit', async () => {
    prisma.affiliateAccount.findUnique.mockResolvedValue(affiliateAccount('unknown_network'));

    await expect(
      service.createAffiliateIncome(
        { settlementMonth: '2026-06', affiliateAccountId: '10000000-0000-0000-0000-000000000001' },
        actor,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    expect(prisma.syncTask.create).not.toHaveBeenCalled();
    expect(audit.failure).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sync_task.create.affiliate_income',
        failureReason: ERROR_CODES.VALIDATION_ERROR,
      }),
    );
  });

  it('rejects illegal card provider and writes failure audit', async () => {
    await expect(service.createCardSpend('stripe', { settlementMonth: '2026-06' }, actor)).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
    });

    expect(prisma.syncTask.create).not.toHaveBeenCalled();
    expect(audit.failure).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sync_task.create.card_spend',
        failureReason: ERROR_CODES.VALIDATION_ERROR,
      }),
    );
  });

  it('blocks affiliate and card task creation for locked months', async () => {
    const lockedError = new AppError(ERROR_CODES.MONTH_LOCKED, 'locked');
    monthLock.assertWritable.mockImplementation(async () => {
      await audit.failure({ failureReason: ERROR_CODES.MONTH_LOCKED });
      throw lockedError;
    });
    prisma.affiliateAccount.findUnique.mockResolvedValue(affiliateAccount('everflow'));

    await expect(
      service.createAffiliateIncome(
        { settlementMonth: '2026-06', affiliateAccountId: '10000000-0000-0000-0000-000000000001' },
        actor,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.MONTH_LOCKED });
    await expect(service.createCardSpend('airwallex', { settlementMonth: '2026-06' }, actor)).rejects.toMatchObject({
      code: ERROR_CODES.MONTH_LOCKED,
    });

    expect(prisma.syncTask.create).not.toHaveBeenCalled();
    expect(audit.failure).toHaveBeenCalledWith(expect.objectContaining({ failureReason: ERROR_CODES.MONTH_LOCKED }));
  });

  it('creates card spend placeholder task with not_implemented status', async () => {
    prisma.syncTask.create.mockResolvedValue(
      syncTask({
        sourceType: SyncTaskSourceType.card_spend,
        taskType: SyncTaskType.airwallex_card,
        platform: SyncTaskPlatform.airwallex,
        provider: Provider.airwallex,
      }),
    );

    const task = await service.createCardSpend('airwallex', { settlementMonth: '2026-06' }, actor);

    expect(prisma.syncTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceType: SyncTaskSourceType.card_spend,
          taskType: SyncTaskType.airwallex_card,
          platform: SyncTaskPlatform.airwallex,
          provider: Provider.airwallex,
          status: SyncTaskStatus.not_implemented,
        }),
      }),
    );
    expect(task.status).toBe(SyncTaskStatus.not_implemented);
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync_task.create.airwallex_card' }));
  });

  it('lists tasks with settlementMonth/taskType/platform/affiliateAccountId/status filters and pagination', async () => {
    const record = syncTask({
      taskType: SyncTaskType.affiliate_income,
      platform: SyncTaskPlatform.everflow,
      affiliateAccountId: '10000000-0000-0000-0000-000000000001',
    });
    prisma.syncTask.count.mockResolvedValue(1);
    prisma.syncTask.findMany.mockResolvedValue([record]);

    const result = await service.list({
      settlementMonth: '2026-06-18',
      taskType: 'affiliate_income',
      platform: 'everflow',
      affiliateAccountId: '10000000-0000-0000-0000-000000000001',
      status: 'not_implemented',
      page: '2',
      pageSize: '10',
    });

    expect(prisma.syncTask.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        settlementMonth: new Date(Date.UTC(2026, 5, 1)),
        taskType: SyncTaskType.affiliate_income,
        platform: SyncTaskPlatform.everflow,
        affiliateAccountId: '10000000-0000-0000-0000-000000000001',
        status: SyncTaskStatus.not_implemented,
      }),
    });
    expect(prisma.syncTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
      }),
    );
    expect(result).toMatchObject({
      total: 1,
      page: 2,
      pageSize: 10,
      items: [expect.objectContaining({ taskId: record.id, settlementMonth: '2026-06-01' })],
    });
  });
});

describe('SyncTaskExecutionService', () => {
  let prisma: {
    syncTask: { findUnique: jest.Mock; update: jest.Mock };
    affiliateAccountCredential: { findUnique: jest.Mock };
    cardProviderCredential: { findUnique: jest.Mock };
    incomeRecord: { create: jest.Mock };
    cardSpendEvent: { create: jest.Mock };
  };
  let monthLock: { assertWritable: jest.Mock };
  let audit: { success: jest.Mock; failure: jest.Mock };
  let credentialReader: {
    getAffiliateAccountCredentialPayload: jest.Mock;
    getCardProviderCredentialPayload: jest.Mock;
  };
  let adapters: {
    everflow: { adapterKey: string; execute: jest.Mock };
    cake: { adapterKey: string; execute: jest.Mock };
    airwallex: { adapterKey: string; execute: jest.Mock };
    photonpay: { adapterKey: string; execute: jest.Mock };
  };
  let service: SyncTaskExecutionService;

  beforeEach(() => {
    prisma = {
      syncTask: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      affiliateAccountCredential: { findUnique: jest.fn() },
      cardProviderCredential: { findUnique: jest.fn() },
      incomeRecord: { create: jest.fn() },
      cardSpendEvent: { create: jest.fn() },
    };
    monthLock = { assertWritable: jest.fn().mockResolvedValue(undefined) };
    audit = {
      success: jest.fn().mockResolvedValue({ id: 'audit-success' }),
      failure: jest.fn().mockResolvedValue({ id: 'audit-failure' }),
    };
    credentialReader = {
      getAffiliateAccountCredentialPayload: jest.fn().mockResolvedValue({
        credentialId: 'affiliate-cred-1',
        maskedPayload: { apiKey: 'mask****cret' },
        payload: { apiKey: 'plain-secret' },
      }),
      getCardProviderCredentialPayload: jest.fn().mockResolvedValue({
        credentialId: 'card-cred-1',
        maskedPayload: { apiKey: 'mask****cret' },
        payload: { apiKey: 'plain-secret' },
      }),
    };
    adapters = {
      everflow: stubAdapter('affiliate_income.everflow.stub'),
      cake: stubAdapter('affiliate_income.cake'),
      airwallex: stubAdapter('card_spend.airwallex.stub'),
      photonpay: stubAdapter('card_spend.photonpay'),
    };
    const resolver = new SyncAdapterResolver(
      adapters.everflow as never,
      adapters.cake as never,
      adapters.airwallex as never,
      adapters.photonpay as never,
    );
    service = new SyncTaskExecutionService(prisma as never, monthLock as never, audit as never, resolver, credentialReader as never);
  });

  it('execute affiliate_income uses affiliateAccount.platform for everflow/cake adapter, not account name', async () => {
    const original = syncTask({
      platform: SyncTaskPlatform.everflow,
      affiliateAccount: { ...affiliateAccount('cake'), accountName: 'Concrete account' },
    });
    mockExecutableAffiliateTask(original, syncTask({ ...original, status: SyncTaskStatus.running }), syncTask({
      ...original,
      status: SyncTaskStatus.failed,
      failedCount: 1,
      errorMessage: SYNC_ADAPTER_NOT_IMPLEMENTED_ERROR,
      resultPayload: { adapterKey: 'affiliate_income.cake', implemented: false, pulledThirdPartyData: false },
    }));

    const result = await service.execute(original.id, actor);

    expect(adapters.cake.execute).toHaveBeenCalledTimes(1);
    expect(adapters.everflow.execute).not.toHaveBeenCalled();
    expect(adapters.cake.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({ credentialId: 'affiliate-cred-1', hasCredential: true, payload: { apiKey: 'plain-secret' } }),
      }),
    );
    expect(result.status).toBe(SyncTaskStatus.failed);
    expect(JSON.stringify(audit.success.mock.calls)).not.toContain('plain-secret');
  });

  it('blocks affiliate_income execution without active affiliate credential', async () => {
    const task = syncTask();
    prisma.syncTask.findUnique.mockResolvedValue(task);
    prisma.affiliateAccountCredential.findUnique.mockResolvedValue(null);

    await expect(service.execute(task.id, actor)).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    expect(prisma.syncTask.update).not.toHaveBeenCalled();
    expect(adapters.everflow.execute).not.toHaveBeenCalled();
    expect(audit.failure).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sync_task.execute',
        objectType: 'sync_tasks',
        objectId: task.id,
        failureReason: ERROR_CODES.VALIDATION_ERROR,
      }),
    );
  });

  it('blocks card_spend execution without active provider credential', async () => {
    const task = syncTask({
      sourceType: SyncTaskSourceType.card_spend,
      taskType: SyncTaskType.airwallex_card,
      platform: SyncTaskPlatform.airwallex,
      affiliateAccountId: null,
      affiliateAccount: null,
      provider: Provider.airwallex,
    });
    prisma.syncTask.findUnique.mockResolvedValue(task);
    prisma.cardProviderCredential.findUnique.mockResolvedValue({ id: 'card-cred-1', status: CommonStatus.disabled, maskedPayload: {} });

    await expect(service.execute(task.id, actor)).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    expect(prisma.syncTask.update).not.toHaveBeenCalled();
    expect(adapters.airwallex.execute).not.toHaveBeenCalled();
  });

  it('blocks locked settlement month execution', async () => {
    const lockedError = new AppError(ERROR_CODES.MONTH_LOCKED, 'locked');
    const task = syncTask();
    prisma.syncTask.findUnique.mockResolvedValue(task);
    monthLock.assertWritable.mockImplementation(async () => {
      await audit.failure({ action: 'sync_task.execute', failureReason: ERROR_CODES.MONTH_LOCKED });
      throw lockedError;
    });

    await expect(service.execute(task.id, actor)).rejects.toMatchObject({ code: ERROR_CODES.MONTH_LOCKED });

    expect(prisma.affiliateAccountCredential.findUnique).not.toHaveBeenCalled();
    expect(prisma.syncTask.update).not.toHaveBeenCalled();
    expect(audit.failure).toHaveBeenCalledWith(expect.objectContaining({ failureReason: ERROR_CODES.MONTH_LOCKED }));
  });

  it.each([SyncTaskStatus.running, SyncTaskStatus.completed])('blocks duplicate execution when task is %s', async (status) => {
    const task = syncTask({ status });
    prisma.syncTask.findUnique.mockResolvedValue(task);

    await expect(service.execute(task.id, actor)).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });

    expect(monthLock.assertWritable).not.toHaveBeenCalled();
    expect(prisma.syncTask.update).not.toHaveBeenCalled();
    expect(audit.failure).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync_task.execute' }));
  });

  it('stub execution ends as failed with explicit not-implemented error and writes no income/card events', async () => {
    const original = syncTask();
    const running = syncTask({ ...original, status: SyncTaskStatus.running, startedAt: new Date(Date.UTC(2026, 5, 19, 1)) });
    const failed = syncTask({
      ...original,
      status: SyncTaskStatus.failed,
      failedCount: 1,
      startedAt: running.startedAt,
      finishedAt: new Date(Date.UTC(2026, 5, 19, 1, 0, 1)),
      errorMessage: SYNC_ADAPTER_NOT_IMPLEMENTED_ERROR,
      resultPayload: { adapterKey: 'affiliate_income.everflow.stub', implemented: false, pulledThirdPartyData: false },
    });
    mockExecutableAffiliateTask(original, running, failed);

    const result = await service.execute(original.id, actor);

    expect(result.status).toBe(SyncTaskStatus.failed);
    expect(result.errorMessage).toBe(SYNC_ADAPTER_NOT_IMPLEMENTED_ERROR);
    expect(prisma.syncTask.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ status: SyncTaskStatus.running }) }),
    );
    expect(prisma.syncTask.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          status: SyncTaskStatus.failed,
          failedCount: 1,
          errorMessage: SYNC_ADAPTER_NOT_IMPLEMENTED_ERROR,
        }),
      }),
    );
    expect(prisma.incomeRecord.create).not.toHaveBeenCalled();
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sync_task.execute',
        objectType: 'sync_tasks',
        objectId: original.id,
        requestPayload: expect.objectContaining({
          taskId: original.id,
          taskType: SyncTaskType.affiliate_income,
          platform: SyncTaskPlatform.everflow,
          settlementMonth: '2026-06-01',
        }),
        afterData: expect.objectContaining({
          status: SyncTaskStatus.failed,
          failedCount: 1,
          errorMessage: SYNC_ADAPTER_NOT_IMPLEMENTED_ERROR,
        }),
      }),
    );
  });

  it('completed adapter result ends task as completed and keeps apiKey out of audit/resultPayload', async () => {
    const original = syncTask();
    const running = syncTask({ ...original, status: SyncTaskStatus.running, startedAt: new Date(Date.UTC(2026, 5, 19, 1)) });
    const completed = syncTask({
      ...original,
      status: SyncTaskStatus.completed,
      successCount: 1,
      failedCount: 0,
      message: 'Everflow income sync finished: successCount=1, failedCount=0.',
      errorMessage: null,
      resultPayload: { adapterKey: 'affiliate_income.everflow', successCount: 1, failedCount: 0 },
    });
    adapters.everflow.execute.mockResolvedValueOnce({
      status: 'completed',
      successCount: 1,
      failedCount: 0,
      message: 'Everflow income sync finished: successCount=1, failedCount=0.',
      errorMessage: null,
      resultPayload: { adapterKey: 'affiliate_income.everflow', successCount: 1, failedCount: 0 },
    });
    mockExecutableAffiliateTask(original, running, completed);

    const result = await service.execute(original.id, actor);

    expect(result.status).toBe(SyncTaskStatus.completed);
    expect(prisma.syncTask.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          status: SyncTaskStatus.completed,
          successCount: 1,
          failedCount: 0,
          resultPayload: { adapterKey: 'affiliate_income.everflow', successCount: 1, failedCount: 0 },
        }),
      }),
    );
    expect(JSON.stringify(audit.success.mock.calls)).not.toContain('plain-secret');
    expect(JSON.stringify(result.resultPayload)).not.toContain('plain-secret');
  });

  it('injected card adapters can fail without leaking third-party data into writes', async () => {
    const airwallex = await adapters.airwallex.execute({});
    const photonpay = await adapters.photonpay.execute({});

    for (const result of [airwallex, photonpay]) {
      expect(result).toMatchObject({
        status: 'failed',
        errorMessage: SYNC_ADAPTER_NOT_IMPLEMENTED_ERROR,
        resultPayload: { implemented: false, pulledThirdPartyData: false },
      });
    }
  });

  function mockExecutableAffiliateTask(
    original: ReturnType<typeof syncTask>,
    running: ReturnType<typeof syncTask>,
    failed: ReturnType<typeof syncTask>,
  ) {
    prisma.syncTask.findUnique.mockResolvedValue(original);
    prisma.affiliateAccountCredential.findUnique.mockResolvedValue({
      id: 'affiliate-cred-1',
      status: CommonStatus.active,
      maskedPayload: { apiKey: 'mask****cret' },
    });
    prisma.syncTask.update.mockResolvedValueOnce(running).mockResolvedValueOnce(failed);
  }
});

function affiliateAccount(platform: string) {
  return {
    id: '10000000-0000-0000-0000-000000000001',
    platform,
    accountCode: 'acct-1',
    accountName: 'Account 1',
  };
}

function syncTask(overrides: Record<string, unknown> = {}) {
  return { ...baseSyncTask(), ...overrides };
}

function stubAdapter(adapterKey: string) {
  return {
    adapterKey,
    execute: jest.fn().mockResolvedValue({
      status: 'failed',
      successCount: 0,
      failedCount: 1,
      message: null,
      errorMessage: SYNC_ADAPTER_NOT_IMPLEMENTED_ERROR,
      resultPayload: { adapterKey, implemented: false, pulledThirdPartyData: false },
    }),
  };
}

function baseSyncTask() {
  return {
    id: '20000000-0000-0000-0000-000000000001',
    sourceType: SyncTaskSourceType.affiliate_income,
    taskType: SyncTaskType.affiliate_income,
    platform: SyncTaskPlatform.everflow,
    affiliateAccountId: '10000000-0000-0000-0000-000000000001',
    provider: null,
    settlementMonth: new Date(Date.UTC(2026, 5, 1)),
    status: SyncTaskStatus.not_implemented,
    successCount: 0,
    failedCount: 0,
    message: '真实联盟收入同步接口未接入，本任务只记录请求，不拉取第三方数据。',
    errorMessage: null,
    requestedBy: actor.userId,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(Date.UTC(2026, 5, 18)),
    updatedAt: new Date(Date.UTC(2026, 5, 18)),
    requestPayload: {},
    resultPayload: null,
    affiliateAccount: affiliateAccount('everflow'),
  };
}
