import { CommonStatus, Prisma, Provider, SettlementStatus } from '@prisma/client';
import { SyncReconciliationService } from './sync-reconciliation.service';

const employeeId = '30000000-0000-0000-0000-000000000001';
const otherEmployeeId = '30000000-0000-0000-0000-000000000002';
const settlementMonth = new Date(Date.UTC(2026, 5, 1));

describe('SyncReconciliationService', () => {
  let prisma: {
    $transaction: jest.Mock;
    incomeRecord: {
      count: jest.Mock;
      findMany: jest.Mock;
      aggregate: jest.Mock;
      groupBy: jest.Mock;
    };
    cardSpendEvent: {
      count: jest.Mock;
      findMany: jest.Mock;
      aggregate: jest.Mock;
      groupBy: jest.Mock;
    };
    manualCardSpendEntry: {
      groupBy: jest.Mock;
    };
    employee: {
      findMany: jest.Mock;
    };
  };
  let service: SyncReconciliationService;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
      incomeRecord: {
        count: jest.fn(),
        findMany: jest.fn(),
        aggregate: jest.fn(),
        groupBy: jest.fn(),
      },
      cardSpendEvent: {
        count: jest.fn(),
        findMany: jest.fn(),
        aggregate: jest.fn(),
        groupBy: jest.fn(),
      },
      manualCardSpendEntry: {
        groupBy: jest.fn(),
      },
      employee: {
        findMany: jest.fn(),
      },
    };
    service = new SyncReconciliationService(prisma as never);
  });

  it('queries Everflow/CAKE income by affiliateAccountId and settlementMonth', async () => {
    prisma.incomeRecord.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    prisma.incomeRecord.findMany.mockResolvedValue([
      incomeRecord({ source: 'everflow', externalRecordId: 'ef-1', incomeUsd: '100.25' }),
      incomeRecord({
        source: 'cake',
        externalRecordId: 'ck-1',
        incomeUsd: '50.75',
        affiliateAccount: {
          id: '10000000-0000-0000-0000-000000000001',
          platform: 'cake',
          accountCode: 'cake-main',
          accountName: 'CAKE Main',
        },
      }),
    ]);
    prisma.incomeRecord.aggregate
      .mockResolvedValueOnce({ _sum: { incomeUsd: new Prisma.Decimal('151') }, _count: { _all: 2 } })
      .mockResolvedValueOnce({ _sum: { incomeUsd: new Prisma.Decimal('100.25') } });

    const result = await service.affiliateIncome({
      settlementMonth: '2026-06',
      affiliateAccountId: '10000000-0000-0000-0000-000000000001',
      page: '1',
      pageSize: '20',
    });

    expect(prisma.incomeRecord.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        settlementMonth,
        source: { in: ['everflow', 'cake'] },
        affiliateAccountId: '10000000-0000-0000-0000-000000000001',
      }),
    });
    expect(result.summary).toMatchObject({
      totalRevenueUsd: '151',
      matchedRevenueUsd: '100.25',
      unmatchedRevenueUsd: '50.75',
      eventCount: 2,
      matchedCount: 1,
      unmatchedCount: 1,
    });
    expect(result.items.map((item) => item.platform)).toEqual(['everflow', 'cake']);
    expect(result.items[0]).toMatchObject({
      syncTaskId: null,
      importedBy: '20000000-0000-0000-0000-000000000001',
    });
    expect(result.items[0].syncTaskId).not.toBe(result.items[0].importedBy);
  });

  it('keeps Blitz as account identity, not as platform', async () => {
    prisma.incomeRecord.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    prisma.incomeRecord.findMany.mockResolvedValue([
      incomeRecord({
        source: 'cake',
        affiliateAccount: {
          id: '10000000-0000-0000-0000-000000000001',
          platform: 'cake',
          accountCode: 'blitz',
          accountName: 'Blitz',
        },
      }),
    ]);
    prisma.incomeRecord.aggregate
      .mockResolvedValueOnce({ _sum: { incomeUsd: new Prisma.Decimal('10') }, _count: { _all: 1 } })
      .mockResolvedValueOnce({ _sum: { incomeUsd: new Prisma.Decimal('10') } });

    const result = await service.affiliateIncome({ settlementMonth: '2026-06' });

    expect(result.items[0]).toMatchObject({
      affiliateAccountName: 'Blitz',
      affiliateAccountCode: 'blitz',
      platform: 'cake',
    });
    expect(JSON.stringify(result)).not.toContain('"platform":"Blitz"');
    expect(JSON.stringify(result)).not.toContain('"platform":"blitz"');
  });

  it('queries Airwallex/PhotonPay card spend by provider and settlementMonth', async () => {
    prisma.cardSpendEvent.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    prisma.cardSpendEvent.findMany.mockResolvedValue([
      cardSpendEvent({ provider: Provider.airwallex, spendUsd: '42.50' }),
    ]);
    prisma.cardSpendEvent.aggregate
      .mockResolvedValueOnce({ _sum: { spendUsd: new Prisma.Decimal('42.50') }, _count: { _all: 1 } })
      .mockResolvedValueOnce({ _sum: { spendUsd: new Prisma.Decimal('42.50') } });

    const result = await service.cardSpend({ settlementMonth: '2026-06', provider: 'airwallex' });

    expect(prisma.cardSpendEvent.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ settlementMonth, provider: Provider.airwallex }),
    });
    expect(result.items[0]).toMatchObject({
      provider: Provider.airwallex,
      cardId: 'card-1',
      cardLast4: '4242',
      cardEmail: 'card@example.com',
      amountUsd: '42.5',
      syncTaskId: null,
      importedBy: '20000000-0000-0000-0000-000000000001',
    });
    expect(result.items[0].syncTaskId).not.toBe(result.items[0].importedBy);
    expect(result.summary).toMatchObject({
      totalSpendUsd: '42.5',
      matchedSpendUsd: '42.5',
      unmatchedSpendUsd: '0',
    });
  });

  it('recognizes unmatched SUB ID events', async () => {
    prisma.incomeRecord.findMany.mockResolvedValue([
      incomeRecord({ employeeId: null, subValue: 'unknown-sub', incomeUsd: '99' }),
    ]);
    prisma.cardSpendEvent.findMany.mockResolvedValue([]);

    const result = await service.unmatched({ settlementMonth: '2026-06', type: 'affiliate_income' });

    expect(result.affiliateIncomeEvents).toHaveLength(1);
    expect(result.limitation).toContain('sync_unmatched_events');
    expect(result.warnings).toEqual([expect.stringContaining('dedicated unmatched-events page')]);
    expect(result.affiliateIncomeEvents[0]).toMatchObject({
      reason: 'SUB_ID_NOT_MAPPED',
      subId: 'unknown-sub',
      syncTaskId: null,
      importedBy: '20000000-0000-0000-0000-000000000001',
    });
    expect(result.affiliateIncomeEvents[0].syncTaskId).not.toBe(result.affiliateIncomeEvents[0].importedBy);
    expect(result.cardSpendEvents).toHaveLength(0);
  });

  it('recognizes unmatched card mapping events', async () => {
    prisma.incomeRecord.findMany.mockResolvedValue([]);
    prisma.cardSpendEvent.findMany.mockResolvedValue([
      cardSpendEvent({ employeeId: null, cardId: 'missing-card', provider: Provider.photonpay }),
    ]);

    const result = await service.unmatched({ settlementMonth: '2026-06', type: 'card_spend' });

    expect(result.cardSpendEvents).toHaveLength(1);
    expect(result.cardSpendEvents[0]).toMatchObject({
      reason: 'CARD_NOT_MAPPED',
      provider: Provider.photonpay,
      cardId: 'missing-card',
      syncTaskId: null,
      importedBy: '20000000-0000-0000-0000-000000000001',
    });
    expect(result.cardSpendEvents[0].syncTaskId).not.toBe(result.cardSpendEvents[0].importedBy);
    expect(result.affiliateIncomeEvents).toHaveLength(0);
  });

  it('monthly employee summary only sums raw revenue, API spend, manual spend, and raw gross profit', async () => {
    prisma.employee.findMany.mockResolvedValue([
      { id: employeeId, name: 'Alice' },
      { id: otherEmployeeId, name: 'Bob' },
    ]);
    prisma.incomeRecord.groupBy.mockResolvedValue([
      { employeeId, _sum: { incomeUsd: new Prisma.Decimal('10000') } },
    ]);
    prisma.cardSpendEvent.groupBy.mockResolvedValue([
      { employeeId, _sum: { spendUsd: new Prisma.Decimal('3000') } },
    ]);
    prisma.manualCardSpendEntry.groupBy.mockResolvedValue([
      { employeeId, _sum: { actualSpendUsd: new Prisma.Decimal('500') } },
    ]);
    prisma.incomeRecord.count.mockResolvedValue(1);
    prisma.cardSpendEvent.count.mockResolvedValue(1);

    const result = await service.monthlyEmployeeSummary({ settlementMonth: '2026-06' });

    expect(prisma.manualCardSpendEntry.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          settlementMonth,
          status: SettlementStatus.confirmed,
        }),
      }),
    );
    const alice = result.find((item) => item.employeeId === employeeId)!;
    expect(alice).toMatchObject({
      affiliateRevenueUsd: '10000',
      apiCardSpendUsd: '3000',
      manualCardSpendUsd: '500',
      rawGrossProfitUsd: '6500',
      unmatchedFlags: ['missingSubMapping', 'missingCardMapping'],
    });
    expect(JSON.stringify(alice)).not.toContain('baseSalary');
    expect(JSON.stringify(alice)).not.toContain('commissionRate');
    expect(JSON.stringify(alice)).not.toContain('allocationRatio');
    expect(JSON.stringify(alice)).not.toContain('remainingNegativeProfit');
  });

  it('monthly employee summary excludes draft manual card spend from the formal settlement-aligned query', async () => {
    prisma.employee.findMany.mockResolvedValue([{ id: employeeId, name: 'Alice' }]);
    prisma.incomeRecord.groupBy.mockResolvedValue([{ employeeId, _sum: { incomeUsd: new Prisma.Decimal('1000') } }]);
    prisma.cardSpendEvent.groupBy.mockResolvedValue([]);
    prisma.manualCardSpendEntry.groupBy.mockResolvedValue([{ employeeId, _sum: { actualSpendUsd: new Prisma.Decimal('100') } }]);
    prisma.incomeRecord.count.mockResolvedValue(0);
    prisma.cardSpendEvent.count.mockResolvedValue(0);

    const result = await service.monthlyEmployeeSummary({ settlementMonth: '2026-06' });

    expect(prisma.manualCardSpendEntry.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: SettlementStatus.confirmed }),
      }),
    );
    expect(JSON.stringify(prisma.manualCardSpendEntry.groupBy.mock.calls)).not.toContain(SettlementStatus.draft);
    expect(result[0]).toMatchObject({
      manualCardSpendUsd: '100',
      rawGrossProfitUsd: '900',
    });
  });

  it('does not return raw secret fields from rawData', async () => {
    prisma.cardSpendEvent.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    prisma.cardSpendEvent.findMany.mockResolvedValue([
      cardSpendEvent({
        rawData: {
          cardLast4: '4242',
          cardEmail: 'card@example.com',
          apiKey: 'plain-api-key',
          token: 'plain-token',
          secret: 'plain-secret',
          clientId: 'client-id',
          merchantId: 'merchant-id',
          authorization: 'Bearer token',
          signature: 'signature',
          encryptedPayload: 'ciphertext',
        },
      }),
    ]);
    prisma.cardSpendEvent.aggregate
      .mockResolvedValueOnce({ _sum: { spendUsd: new Prisma.Decimal('1') }, _count: { _all: 1 } })
      .mockResolvedValueOnce({ _sum: { spendUsd: new Prisma.Decimal('1') } });

    const result = await service.cardSpend({ settlementMonth: '2026-06' });
    const serialized = JSON.stringify(result);

    for (const forbidden of [
      'plain-api-key',
      'plain-token',
      'plain-secret',
      'client-id',
      'merchant-id',
      'Bearer token',
      'signature',
      'encryptedPayload',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('exports a minimal payout CSV with GMT+8 sales time and no raw payload or secret fields', async () => {
    prisma.incomeRecord.findMany.mockResolvedValue([
      incomeRecord({
        source: 'cake',
        externalRecordId: 'cake-cv-1',
        subField: 'sub1',
        subValue: 'alice-sub',
        incomeUsd: new Prisma.Decimal('12.34'),
        rawData: {
          conversion_date: '2026-05-31T16:00:00.000Z',
          disposition: 'Approved',
          synced_at: '2026-06-02T01:02:03.000Z',
          apiKey: 'must-not-export',
          rawPayload: 'must-not-export',
        },
        affiliateAccount: {
          platform: 'cake',
          accountCode: '329',
          accountName: 'Blitzads',
        },
      }),
    ]);

    const result = await service.exportAffiliatePayoutCsv({ settlementMonth: '2026-06' });

    expect(result.filename).toBe('affiliate-payout-2026-06.csv');
    expect(result.exportedCount).toBe(1);
    expect(result.csv).toContain('结算月份');
    expect(result.csv).toContain('Revenue USD');
    expect(result.csv).toContain('匹配状态');
    expect(result.csv).toContain('sales/conversion time GMT+8');
    expect(result.csv).toContain('2026-06-01 00:00:00 +08:00');
    expect(result.csv).toContain('"cake","Blitzads","329","2026-06","cake-cv-1"');
    expect(result.csv).toContain('"sub1","alice-sub","12.34","Approved","Alice');
    expect(result.csv).toContain('matched');
    expect(result.csv).not.toContain('must-not-export');
    expect(result.csv).not.toContain('apiKey');
    expect(result.csv).not.toContain('rawPayload');
    expect(result.csv).not.toContain('Authorization');
    expect(result.csv).not.toContain('127.0.0.1');
  });
});

function incomeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: '40000000-0000-0000-0000-000000000001',
    settlementMonth,
    affiliateAccountId: '10000000-0000-0000-0000-000000000001',
    employeeId,
    source: 'everflow',
    externalRecordId: 'conversion-1',
    subField: 'sub1',
    subValue: 'alice-sub',
    incomeUsd: new Prisma.Decimal('100'),
    rawData: {
      status: 'approved',
      conversion_time: '2026-06-01T01:00:00.000Z',
      apiKey: 'must-not-leak',
    },
    status: CommonStatus.confirmed,
    importedBy: '20000000-0000-0000-0000-000000000001',
    createdAt: new Date(Date.UTC(2026, 5, 2)),
    updatedAt: new Date(Date.UTC(2026, 5, 2)),
    employee: { id: employeeId, name: 'Alice' },
    affiliateAccount: {
      id: '10000000-0000-0000-0000-000000000001',
      platform: 'everflow',
      accountCode: 'everflow-main',
      accountName: 'Everflow Main',
    },
    ...overrides,
  };
}

function cardSpendEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: '50000000-0000-0000-0000-000000000001',
    settlementMonth,
    provider: Provider.airwallex,
    cardId: 'card-1',
    employeeId,
    externalEventId: 'txn-1',
    transactionAt: new Date(Date.UTC(2026, 5, 3)),
    amount: new Prisma.Decimal('42.50'),
    currency: 'USD',
    spendUsd: new Prisma.Decimal('42.50'),
    settledAt: new Date(Date.UTC(2026, 5, 4)),
    sourceStatus: 'SETTLED',
    sourceUpdatedAt: new Date(Date.UTC(2026, 5, 5)),
    rawData: {
      cardLast4: '4242',
      cardEmail: 'card@example.com',
      apiKey: 'must-not-leak',
    },
    status: CommonStatus.confirmed,
    importedBy: '20000000-0000-0000-0000-000000000001',
    createdAt: new Date(Date.UTC(2026, 5, 6)),
    employee: { id: employeeId, name: 'Alice' },
    ...overrides,
  };
}
