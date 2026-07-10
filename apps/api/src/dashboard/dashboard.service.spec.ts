import { Prisma, Provider, SyncTaskPlatform, SyncTaskStatus } from '@prisma/client';
import { buildTodos, DashboardService } from './dashboard.service';
import { formatSettlementMonth, getCurrentSettlementMonth } from '../settlement/settlement-month.util';

function prismaHarness() {
  const prisma = {
    $transaction: jest.fn((items: Promise<unknown>[]) => Promise.all(items)),
    syncTask: { findMany: jest.fn().mockResolvedValue([]) },
    syncUnmatchedEvent: {
      aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _min: { createdAt: null }, _max: { createdAt: null } }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    monthlySettlement: { findUnique: jest.fn().mockResolvedValue(null) },
    employee: { count: jest.fn().mockResolvedValue(0) },
    incomeRecord: { groupBy: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    cardSpendEvent: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    monthlyExchangeRate: { findFirst: jest.fn().mockResolvedValue(null) },
    monthlyCardProviderFeeRate: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    manualCardSpendEntry: { groupBy: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    monthlySalaryManualItem: { findFirst: jest.fn().mockResolvedValue(null) },
    historicalNegativeProfit: { findFirst: jest.fn().mockResolvedValue(null) },
    monthlyPerformanceGroup: { findFirst: jest.fn().mockResolvedValue(null) },
    monthlyPerformanceGroupMember: { findFirst: jest.fn().mockResolvedValue(null) },
    adminUser: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const reconciliation = {
    affiliateIncome: jest.fn().mockResolvedValue({ summary: { matchedRevenueUsd: '0.3', unmatchedRevenueUsd: '0' } }),
    cardSpend: jest.fn().mockResolvedValue({ summary: { matchedSpendUsd: '0.3', unmatchedSpendUsd: '0' } }),
    monthlyEmployeeSummary: jest.fn().mockResolvedValue([
      { affiliateRevenueUsd: '0.1', apiCardSpendUsd: '0.1', manualCardSpendUsd: '0', rawGrossProfitUsd: '0' },
      { affiliateRevenueUsd: '0.2', apiCardSpendUsd: '0.2', manualCardSpendUsd: '0', rawGrossProfitUsd: '0' },
    ]),
  };
  return { prisma, reconciliation, service: new DashboardService(prisma as never, reconciliation as never) };
}

describe('DashboardService', () => {
  it('uses GMT+8 for the default month, including the UTC month boundary', () => {
    expect(formatSettlementMonth(getCurrentSettlementMonth(new Date('2026-05-31T16:00:00.000Z')))).toBe('2026-06');
  });

  it.each(['2026-6', '2026-06-01', '2026-00', '2026-13', ''])('strictly rejects settlementMonth %p', async (month) => {
    const { service } = prismaHarness();
    await expect(service.overview(month, { userId: 'u', roleCode: 'r', permissions: [] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('returns no protected region and performs no business query for a low-permission user', async () => {
    const { service, prisma, reconciliation } = prismaHarness();
    const result = await service.overview('2026-06', { userId: 'u', roleCode: 'employee', permissions: ['salary.view_self'] });
    expect(result).not.toHaveProperty('sync');
    expect(result).not.toHaveProperty('reconciliation');
    expect(result).not.toHaveProperty('employeesAndSettlement');
    expect(prisma.syncTask.findMany).not.toHaveBeenCalled();
    expect(reconciliation.monthlyEmployeeSummary).not.toHaveBeenCalled();
  });

  it('reuses reconciliation summaries and accumulates Decimal values without floating-point error', async () => {
    const { service } = prismaHarness();
    const result = await service.overview('2026-06', { userId: 'u', roleCode: 'finance', permissions: ['salary.view_all'] });
    expect((result.reconciliation as { affiliateRevenueUsd: string }).affiliateRevenueUsd).toBe(new Prisma.Decimal('0.3').toString());
    expect((result.employeesAndSettlement as { totalSalaryRmb: string }).totalSalaryRmb).toBe('0');
    expect(JSON.stringify(result)).not.toMatch(/passwordHash|tokenHash|rawPayload|encryptedPayload|apiKey|Authorization/);
  });

  it('counts task statuses and only exposes the four enum platforms (Blitz is never a platform)', async () => {
    const { service, prisma } = prismaHarness();
    prisma.syncTask.findMany.mockResolvedValue([
      { status: SyncTaskStatus.completed, platform: SyncTaskPlatform.everflow, provider: null, affiliateAccountId: 'blitz-account', startedAt: null, finishedAt: new Date(), createdAt: new Date() },
      { status: SyncTaskStatus.failed, platform: SyncTaskPlatform.cake, provider: null, affiliateAccountId: null, startedAt: null, finishedAt: new Date(), createdAt: new Date() },
    ]);
    const result = await service.overview('2026-06', { userId: 'u', roleCode: 'ops', permissions: ['income.import'] });
    expect(result.sync).toMatchObject({ taskCount: 2, completedCount: 1, failedCount: 1 });
    expect(JSON.stringify(result.sync)).not.toMatch(/blitz/i);
  });
});

describe('dashboard todo rules', () => {
  const permissions = new Set(['monthly_exchange_rate.manage', 'card_provider_fee_rate.manage']);
  it('triggers every required code using explicit state and counts', () => {
    const todos = buildTodos({
      sync: { taskCount: 0, pendingCount: 2, runningCount: 1, failedCount: 1, runningTooLongCount: 1 },
      unmatched: { affiliateIncomeCount: 3, cardSpendCount: 4 },
      settlement: { monthStatus: { isLocked: false, settlementStatus: 'not_generated' }, missingExchangeRate: true, missingFeeProviders: [Provider.airwallex], isOutdated: true },
      permissions,
    });
    expect(new Set(todos.map((todo) => todo.code))).toEqual(new Set([
      'SYNC_NOT_CREATED', 'SYNC_PENDING', 'SYNC_RUNNING_TOO_LONG', 'SYNC_FAILED', 'UNMATCHED_AFFILIATE_INCOME', 'UNMATCHED_CARD_SPEND',
      'MISSING_EXCHANGE_RATE', 'MISSING_CARD_PROVIDER_FEE_RATE', 'SETTLEMENT_NOT_GENERATED', 'SETTLEMENT_OUTDATED', 'MONTH_NOT_LOCKED',
    ]));
    expect(todos.every((todo) => ['info', 'warning', 'error'].includes(todo.severity))).toBe(true);
  });

  it('emits only MONTH_LOCKED for a clean locked month and does not guess outdated', () => {
    const todos = buildTodos({
      sync: { taskCount: 1, pendingCount: 0, runningCount: 0, failedCount: 0, runningTooLongCount: 0 },
      unmatched: { affiliateIncomeCount: 0, cardSpendCount: 0 },
      settlement: { monthStatus: { isLocked: true, settlementStatus: 'locked' }, missingExchangeRate: false, missingFeeProviders: [], isOutdated: false },
      permissions,
    });
    expect(todos.map((todo) => todo.code)).toEqual(['MONTH_LOCKED']);
  });
});
