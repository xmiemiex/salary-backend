import {
  Prisma,
  Provider,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskType,
  SyncUnmatchedEventStatus,
} from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { ResolveAfterSuccessfulImportInput, SyncUnmatchedEventsService } from './sync-unmatched-events.service';

const actor = {
  userId: '00000000-0000-0000-0000-000000000001',
  roleCode: 'finance',
  permissions: ['settlement.generate', 'salary.view_all'],
  ipAddress: '127.0.0.1',
  userAgent: 'jest',
};

const employeeId = '30000000-0000-0000-0000-000000000001';
const settlementMonth = new Date(Date.UTC(2026, 5, 1));

describe('SyncUnmatchedEventsService', () => {
  let prisma: {
    $transaction: jest.Mock;
    syncUnmatchedEvent: {
      count: jest.Mock;
      findMany: jest.Mock;
      aggregate: jest.Mock;
      groupBy: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    employee: { findUnique: jest.Mock };
    incomeRecord: { create: jest.Mock };
    cardSpendEvent: { create: jest.Mock };
  };
  let audit: { success: jest.Mock };
  let service: SyncUnmatchedEventsService;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
      syncUnmatchedEvent: {
        count: jest.fn(),
        findMany: jest.fn(),
        aggregate: jest.fn(),
        groupBy: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(({ data }) => Promise.resolve(eventFromPrismaData(data))),
        update: jest.fn(({ data }) => Promise.resolve(unmatchedEvent(data))),
      },
      employee: { findUnique: jest.fn() },
      incomeRecord: { create: jest.fn() },
      cardSpendEvent: { create: jest.fn() },
    };
    audit = { success: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    service = new SyncUnmatchedEventsService(prisma as never, audit as never);
  });

  it('creates affiliate_income unmatched events with sanitized rawSafeData', async () => {
    prisma.syncUnmatchedEvent.findUnique.mockResolvedValue(null);

    const result = await service.recordUnmatchedEvent({
      settlementMonth: '2026-06',
      sourceType: 'affiliate_income',
      taskType: 'affiliate_income',
      platform: 'everflow',
      affiliateAccountId: '10000000-0000-0000-0000-000000000001',
      syncTaskId: '20000000-0000-0000-0000-000000000001',
      thirdPartyEventId: 'conversion-1',
      reasonCode: 'SUB_ID_NOT_MAPPED',
      subField: 'sub1',
      subValue: 'unknown-sub',
      amountUsd: '123.456',
      currency: 'USD',
      occurredAt: '2026-06-02T00:00:00.000Z',
      rawSafeData: rawWithSecrets(),
    });

    expect(prisma.syncUnmatchedEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceType: SyncTaskSourceType.affiliate_income,
          taskType: SyncTaskType.affiliate_income,
          platform: SyncTaskPlatform.everflow,
          reasonCode: 'SUB_ID_NOT_MAPPED',
          rawSafeData: expect.objectContaining({ conversionId: 'conversion-1', sub1: 'unknown-sub' }),
        }),
      }),
    );
    expect(result).toMatchObject({
      sourceType: SyncTaskSourceType.affiliate_income,
      platform: SyncTaskPlatform.everflow,
      affiliateAccountName: 'Everflow Main',
      reasonCode: 'SUB_ID_NOT_MAPPED',
      amountUsd: '123.456',
      rawSafeData: expect.objectContaining({ conversionId: 'conversion-1' }),
    });
    expect(JSON.stringify(result)).not.toContain('plain-api-key');
    expect(JSON.stringify(result)).not.toContain('plain-token');
    expect(JSON.stringify(result)).not.toContain('plain-secret');
    expect(JSON.stringify(result)).not.toContain('client-id');
    expect(JSON.stringify(result)).not.toContain('merchant-id');
    expect(JSON.stringify(result)).not.toContain('Bearer token');
    expect(JSON.stringify(result)).not.toContain('signature-value');
    expect(JSON.stringify(result)).not.toContain('plain-password');
    expect(JSON.stringify(result)).not.toContain('ciphertext');
  });

  it('automatically resolves an open reconciliation event after a successful idempotent re-sync', async () => {
    prisma.syncUnmatchedEvent.findUnique.mockResolvedValue({
      id: 'unmatched-1',
      status: SyncUnmatchedEventStatus.open,
      settlementMonth,
      platform: null,
      provider: Provider.photonpay,
      affiliateAccountId: null,
      subField: null,
      subValue: null,
      cardId: 'card-1',
    });
    prisma.syncUnmatchedEvent.update.mockResolvedValue({});
    const result = await service.resolveAfterSuccessfulImport({
      settlementMonth,
      sourceType: SyncTaskSourceType.card_spend,
      taskType: SyncTaskType.photonpay_card,
      provider: Provider.photonpay,
      thirdPartyEventId: 'txn-1',
      cardId: 'card-1',
      employeeId,
      resolvedBy: actor.userId,
    });
    expect(result).toBe(true);
    expect(prisma.syncUnmatchedEvent.update).toHaveBeenCalledWith({
      where: { id: 'unmatched-1' },
      data: expect.objectContaining({
        status: SyncUnmatchedEventStatus.resolved,
        resolvedEmployeeId: employeeId,
        resolvedBy: actor.userId,
      }),
    });
  });

  it('does not resolve an affiliate event outside the exact account, month, platform, or SUB identity', async () => {
    const existing = {
      id: 'unmatched-1',
      status: SyncUnmatchedEventStatus.open,
      settlementMonth,
      platform: SyncTaskPlatform.cake,
      provider: null,
      affiliateAccountId: 'account-expected',
      subField: 'sub1',
      subValue: 'ZW',
      cardId: null,
    };
    const baseInput: ResolveAfterSuccessfulImportInput = {
      settlementMonth,
      sourceType: SyncTaskSourceType.affiliate_income,
      taskType: SyncTaskType.affiliate_income,
      platform: SyncTaskPlatform.cake,
      affiliateAccountId: 'account-expected',
      thirdPartyEventId: 'cake-row-1',
      subField: 'sub1',
      subValue: 'ZW',
      employeeId,
    };
    const mismatches = [
      { affiliateAccountId: 'account-other' },
      { settlementMonth: new Date('2026-05-01T00:00:00.000Z') },
      { platform: SyncTaskPlatform.everflow },
      { subField: 'sub2' },
      { subValue: 'MSY' },
    ];
    for (const mismatch of mismatches) {
      prisma.syncUnmatchedEvent.findUnique.mockResolvedValueOnce({ ...existing, ...mismatch });
      await expect(service.resolveAfterSuccessfulImport(baseInput)).resolves.toBe(false);
    }
    expect(prisma.syncUnmatchedEvent.update).not.toHaveBeenCalled();
  });

  it('does not resolve a card event for another provider or card', async () => {
    const input: ResolveAfterSuccessfulImportInput = {
      settlementMonth,
      sourceType: SyncTaskSourceType.card_spend,
      taskType: SyncTaskType.photonpay_card,
      provider: Provider.photonpay,
      thirdPartyEventId: 'txn-1',
      cardId: 'card-expected',
      employeeId,
    };
    const existing = {
      id: 'unmatched-1',
      status: SyncUnmatchedEventStatus.open,
      settlementMonth,
      platform: null,
      provider: Provider.photonpay,
      affiliateAccountId: null,
      subField: null,
      subValue: null,
      cardId: 'card-expected',
    };
    for (const mismatch of [{ provider: Provider.airwallex }, { cardId: 'card-other' }]) {
      prisma.syncUnmatchedEvent.findUnique.mockResolvedValueOnce({ ...existing, ...mismatch });
      await expect(service.resolveAfterSuccessfulImport(input)).resolves.toBe(false);
    }
    expect(prisma.syncUnmatchedEvent.update).not.toHaveBeenCalled();
  });

  it('leaves an already resolved event unchanged on a repeated successful import', async () => {
    prisma.syncUnmatchedEvent.findUnique.mockResolvedValue({
      id: 'unmatched-1',
      status: SyncUnmatchedEventStatus.resolved,
      settlementMonth,
      platform: SyncTaskPlatform.cake,
      provider: null,
      affiliateAccountId: 'account-1',
      subField: 'sub1',
      subValue: 'ZW',
      cardId: null,
    });
    await expect(service.resolveAfterSuccessfulImport({
      settlementMonth,
      sourceType: SyncTaskSourceType.affiliate_income,
      taskType: SyncTaskType.affiliate_income,
      platform: SyncTaskPlatform.cake,
      affiliateAccountId: 'account-1',
      thirdPartyEventId: 'cake-row-1',
      subField: 'sub1',
      subValue: 'ZW',
      employeeId,
    })).resolves.toBe(false);
    expect(prisma.syncUnmatchedEvent.update).not.toHaveBeenCalled();
  });

  it('creates card_spend unmatched events', async () => {
    prisma.syncUnmatchedEvent.findUnique.mockResolvedValue(null);

    const result = await service.recordUnmatchedEvent({
      settlementMonth: '2026-06-01',
      sourceType: 'card_spend',
      taskType: 'airwallex_card',
      provider: 'airwallex',
      thirdPartyEventId: 'txn-1',
      reasonCode: 'CARD_NOT_MAPPED',
      cardId: 'card-1',
      cardLast4: '4242',
      cardEmail: 'card@example.com',
      amountUsd: new Prisma.Decimal('42.5'),
      currency: 'USD',
      rawData: { transactionId: 'txn-1', cardId: 'card-1', apiKey: 'plain-api-key' },
    });

    expect(prisma.syncUnmatchedEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceType: SyncTaskSourceType.card_spend,
          taskType: SyncTaskType.airwallex_card,
          provider: Provider.airwallex,
          platform: undefined,
          reasonCode: 'CARD_NOT_MAPPED',
        }),
      }),
    );
    expect(result).toMatchObject({
      sourceType: SyncTaskSourceType.card_spend,
      taskType: SyncTaskType.airwallex_card,
      provider: Provider.airwallex,
      cardId: 'card-1',
      cardLast4: '4242',
      cardEmail: 'card@example.com',
      amountUsd: '42.5',
    });
    expect(JSON.stringify(result)).not.toContain('plain-api-key');
  });

  it('updates the existing open event for the same sourceType/taskType/thirdPartyEventId', async () => {
    prisma.syncUnmatchedEvent.findUnique.mockResolvedValue(unmatchedEvent({ thirdPartyEventId: 'conversion-1' }));
    prisma.syncUnmatchedEvent.update.mockResolvedValue(
      unmatchedEvent({ thirdPartyEventId: 'conversion-1', reasonMessage: 'new reason', amountUsd: new Prisma.Decimal('99') }),
    );

    const result = await service.recordUnmatchedEvent({
      settlementMonth: '2026-06',
      sourceType: 'affiliate_income',
      taskType: 'affiliate_income',
      platform: 'cake',
      thirdPartyEventId: 'conversion-1',
      reasonCode: 'SUB_ID_NOT_MAPPED',
      reasonMessage: 'new reason',
      amountUsd: '99',
    });

    expect(prisma.syncUnmatchedEvent.create).not.toHaveBeenCalled();
    expect(prisma.syncUnmatchedEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '60000000-0000-0000-0000-000000000001' },
        data: expect.objectContaining({ reasonMessage: 'new reason', status: SyncUnmatchedEventStatus.open }),
      }),
    );
    expect(result).toMatchObject({ thirdPartyEventId: 'conversion-1', reasonMessage: 'new reason', amountUsd: '99' });
  });

  it('filters list by settlementMonth/status/sourceType/provider/platform/reasonCode and returns summary', async () => {
    prisma.syncUnmatchedEvent.count.mockResolvedValue(2);
    prisma.syncUnmatchedEvent.findMany.mockResolvedValue([
      unmatchedEvent({ reasonCode: 'SUB_ID_NOT_MAPPED', amountUsd: new Prisma.Decimal('10') }),
      unmatchedEvent({
        id: '60000000-0000-0000-0000-000000000002',
        sourceType: SyncTaskSourceType.card_spend,
        taskType: SyncTaskType.photonpay_card,
        platform: null,
        provider: Provider.photonpay,
        reasonCode: 'CARD_NOT_MAPPED',
        amountUsd: new Prisma.Decimal('5'),
      }),
    ]);
    prisma.syncUnmatchedEvent.aggregate.mockResolvedValue({
      _sum: { amountUsd: new Prisma.Decimal('15') },
      _count: { _all: 2 },
    });
    prisma.syncUnmatchedEvent.groupBy
      .mockResolvedValueOnce([
        { status: SyncUnmatchedEventStatus.open, _count: { _all: 1 } },
        { status: SyncUnmatchedEventStatus.ignored, _count: { _all: 1 } },
      ])
      .mockResolvedValueOnce([
        { reasonCode: 'SUB_ID_NOT_MAPPED', _count: { _all: 1 } },
        { reasonCode: 'CARD_NOT_MAPPED', _count: { _all: 1 } },
      ])
      .mockResolvedValueOnce([
        { sourceType: SyncTaskSourceType.affiliate_income, _count: { _all: 1 } },
        { sourceType: SyncTaskSourceType.card_spend, _count: { _all: 1 } },
      ]);

    const result = await service.list({
      settlementMonth: '2026-06',
      status: 'open',
      sourceType: 'affiliate_income',
      provider: 'airwallex',
      platform: 'everflow',
      reasonCode: 'SUB_ID_NOT_MAPPED',
      page: '2',
      pageSize: '10',
    });

    expect(prisma.syncUnmatchedEvent.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        settlementMonth,
        status: SyncUnmatchedEventStatus.open,
        sourceType: SyncTaskSourceType.affiliate_income,
        provider: Provider.airwallex,
        platform: SyncTaskPlatform.everflow,
        reasonCode: 'SUB_ID_NOT_MAPPED',
      }),
    });
    expect(prisma.syncUnmatchedEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
    expect(result.summary).toEqual({
      totalCount: 2,
      openCount: 1,
      ignoredCount: 1,
      resolvedCount: 0,
      totalAmountUsd: '15',
      byReasonCode: { SUB_ID_NOT_MAPPED: 1, CARD_NOT_MAPPED: 1 },
      bySourceType: { affiliate_income: 1, card_spend: 1 },
    });
  });

  it('ignore changes status and writes resolvedAt/resolvedBy/resolutionNote with audit', async () => {
    const before = unmatchedEvent({ status: SyncUnmatchedEventStatus.open });
    prisma.syncUnmatchedEvent.findUnique.mockResolvedValue(before);
    prisma.syncUnmatchedEvent.update.mockResolvedValue(
      unmatchedEvent({
        status: SyncUnmatchedEventStatus.ignored,
        resolvedAt: new Date(Date.UTC(2026, 5, 19)),
        resolvedBy: actor.userId,
        resolutionNote: 'ignore it',
      }),
    );

    const result = await service.ignore(before.id, { resolutionNote: 'ignore it' }, actor);

    expect(prisma.syncUnmatchedEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: before.id },
        data: expect.objectContaining({
          status: SyncUnmatchedEventStatus.ignored,
          resolvedBy: actor.userId,
          resolutionNote: 'ignore it',
        }),
      }),
    );
    expect(result).toMatchObject({
      status: SyncUnmatchedEventStatus.ignored,
      resolvedBy: actor.userId,
      resolutionNote: 'ignore it',
    });
    expect(result.resolvedAt).toBeInstanceOf(Date);
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sync_unmatched_event.ignore',
        objectType: 'sync_unmatched_events',
        objectId: before.id,
        changedFields: ['status', 'resolvedAt', 'resolvedBy', 'resolutionNote'],
      }),
    );
  });

  it('resolve changes status but does not create incomeRecord or cardSpendEvent', async () => {
    const before = unmatchedEvent({ status: SyncUnmatchedEventStatus.open });
    prisma.syncUnmatchedEvent.findUnique.mockResolvedValue(before);
    prisma.employee.findUnique.mockResolvedValue({ id: employeeId });
    prisma.syncUnmatchedEvent.update.mockResolvedValue(
      unmatchedEvent({
        status: SyncUnmatchedEventStatus.resolved,
        resolvedEmployeeId: employeeId,
        resolvedEmployee: { id: employeeId, name: 'Alice' },
        resolvedAt: new Date(Date.UTC(2026, 5, 19)),
        resolvedBy: actor.userId,
        resolutionNote: 'matched manually',
      }),
    );

    const result = await service.resolve(before.id, { resolvedEmployeeId: employeeId, resolutionNote: 'matched manually' }, actor);

    expect(prisma.employee.findUnique).toHaveBeenCalledWith({ where: { id: employeeId }, select: { id: true } });
    expect(result).toMatchObject({
      status: SyncUnmatchedEventStatus.resolved,
      resolvedEmployeeId: employeeId,
      resolvedEmployeeName: 'Alice',
      resolutionNote: 'matched manually',
    });
    expect(prisma.incomeRecord.create).not.toHaveBeenCalled();
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sync_unmatched_event.resolve',
        changedFields: ['status', 'resolvedEmployeeId', 'resolvedAt', 'resolvedBy', 'resolutionNote'],
      }),
    );
  });

  it('rejects resolve without resolvedEmployeeId', async () => {
    prisma.syncUnmatchedEvent.findUnique.mockResolvedValue(unmatchedEvent());

    await expect(service.resolve('60000000-0000-0000-0000-000000000001', {}, actor)).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
    });
    expect(prisma.syncUnmatchedEvent.update).not.toHaveBeenCalled();
  });

  it('keeps Blitz as affiliateAccountName/accountCode and never as platform', async () => {
    prisma.syncUnmatchedEvent.count.mockResolvedValue(1);
    prisma.syncUnmatchedEvent.findMany.mockResolvedValue([
      unmatchedEvent({
        platform: SyncTaskPlatform.cake,
        affiliateAccount: {
          id: '10000000-0000-0000-0000-000000000001',
          platform: 'cake',
          accountCode: 'blitz',
          accountName: 'Blitz',
        },
      }),
    ]);
    prisma.syncUnmatchedEvent.aggregate.mockResolvedValue({
      _sum: { amountUsd: new Prisma.Decimal('1') },
      _count: { _all: 1 },
    });
    prisma.syncUnmatchedEvent.groupBy
      .mockResolvedValueOnce([{ status: SyncUnmatchedEventStatus.open, _count: { _all: 1 } }])
      .mockResolvedValueOnce([{ reasonCode: 'SUB_ID_NOT_MAPPED', _count: { _all: 1 } }])
      .mockResolvedValueOnce([{ sourceType: SyncTaskSourceType.affiliate_income, _count: { _all: 1 } }]);

    const result = await service.list({ settlementMonth: '2026-06' });

    expect(result.items[0]).toMatchObject({
      platform: SyncTaskPlatform.cake,
      affiliateAccountName: 'Blitz',
      affiliateAccountCode: 'blitz',
    });
    expect(JSON.stringify(result)).not.toContain('"platform":"Blitz"');
    expect(JSON.stringify(result)).not.toContain('"platform":"blitz"');
  });

  it('does not accept Blitz as platform when recording events', async () => {
    await expect(
      service.recordUnmatchedEvent({
        settlementMonth: '2026-06',
        sourceType: 'affiliate_income',
        taskType: 'affiliate_income',
        platform: 'blitz',
        reasonCode: 'SUB_ID_NOT_MAPPED',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    expect(prisma.syncUnmatchedEvent.create).not.toHaveBeenCalled();
  });
});

function unmatchedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: '60000000-0000-0000-0000-000000000001',
    settlementMonth,
    sourceType: SyncTaskSourceType.affiliate_income,
    taskType: SyncTaskType.affiliate_income,
    platform: SyncTaskPlatform.everflow,
    provider: null,
    affiliateAccountId: '10000000-0000-0000-0000-000000000001',
    syncTaskId: '20000000-0000-0000-0000-000000000001',
    thirdPartyEventId: 'conversion-1',
    reasonCode: 'SUB_ID_NOT_MAPPED',
    reasonMessage: null,
    subField: 'sub1',
    subValue: 'unknown-sub',
    cardId: null,
    cardLast4: null,
    cardEmail: null,
    amountUsd: new Prisma.Decimal('123.456'),
    currency: 'USD',
    occurredAt: new Date(Date.UTC(2026, 5, 2)),
    rawSafeData: { conversionId: 'conversion-1', sub1: 'unknown-sub' },
    status: SyncUnmatchedEventStatus.open,
    resolvedEmployeeId: null,
    resolutionNote: null,
    createdAt: new Date(Date.UTC(2026, 5, 3)),
    updatedAt: new Date(Date.UTC(2026, 5, 3)),
    resolvedAt: null,
    resolvedBy: null,
    affiliateAccount: {
      id: '10000000-0000-0000-0000-000000000001',
      platform: 'everflow',
      accountCode: 'everflow-main',
      accountName: 'Everflow Main',
    },
    resolvedEmployee: null,
    ...overrides,
  };
}

function eventFromPrismaData(data: Record<string, unknown>) {
  const affiliateAccount = data.affiliateAccount
    ? {
        id: (data.affiliateAccount as { connect: { id: string } }).connect.id,
        platform: data.platform as string,
        accountCode: data.platform === SyncTaskPlatform.cake ? 'cake-main' : 'everflow-main',
        accountName: data.platform === SyncTaskPlatform.cake ? 'CAKE Main' : 'Everflow Main',
      }
    : null;
  return unmatchedEvent({
    ...data,
    affiliateAccountId: affiliateAccount?.id ?? null,
    syncTaskId: data.syncTask ? (data.syncTask as { connect: { id: string } }).connect.id : null,
    affiliateAccount,
  });
}

function rawWithSecrets() {
  return {
    conversionId: 'conversion-1',
    sub1: 'unknown-sub',
    status: 'approved',
    ignoredField: 'must-not-persist',
    apiKey: 'plain-api-key',
    token: 'plain-token',
    secret: 'plain-secret',
    clientId: 'client-id',
    merchantId: 'merchant-id',
    authorization: 'Bearer token',
    signature: 'signature-value',
    password: 'plain-password',
    encryptedPayload: 'ciphertext',
    message: {
      text: 'safe nested message',
      token: 'nested-token',
      encryptedPayload: 'nested-ciphertext',
    },
  };
}
