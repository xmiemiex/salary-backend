import {
  CommonStatus,
  Prisma,
  Provider,
  SettlementStatus,
  SyncTaskSourceType,
  SyncTaskStatus,
  SyncUnmatchedEventStatus,
} from '@prisma/client';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { SettlementPreflightService } from './settlement-preflight.service';

describe('SettlementPreflightService', () => {
  const settlementMonth = new Date('2026-06-01T00:00:00.000Z');

  function decimal(value: string) {
    return new Prisma.Decimal(value);
  }

  function createHarness(
    overrides: {
      settlement?: unknown;
      exchangeRate?: unknown;
      confirmedApiSpendProviders?: unknown[];
      activeProviderFeeRates?: unknown[];
      unmatchedCount?: number;
      unmatchedAmountUsd?: Prisma.Decimal | null;
      unmatchedBySourceAndReason?: unknown[];
      manualDraftCounts?: {
        manualIncome?: number;
        manualCardSpend?: number;
        salaryManualItem?: number;
        historicalNegativeProfit?: number;
      };
      syncTaskCounts?: unknown[];
    } = {},
  ) {
    const manualDraftCounts = overrides.manualDraftCounts ?? {};
    const prisma = {
      monthlySettlement: {
        findUnique: jest.fn().mockResolvedValue(overrides.settlement ?? null),
      },
      monthlyExchangeRate: {
        findFirst: jest.fn().mockResolvedValue(overrides.exchangeRate === undefined ? { id: 'rate-1' } : overrides.exchangeRate),
      },
      cardSpendEvent: {
        findMany: jest.fn().mockResolvedValue(overrides.confirmedApiSpendProviders ?? []),
      },
      monthlyCardProviderFeeRate: {
        findMany: jest.fn().mockResolvedValue(overrides.activeProviderFeeRates ?? []),
      },
      syncUnmatchedEvent: {
        aggregate: jest.fn().mockResolvedValue({
          _count: { _all: overrides.unmatchedCount ?? 0 },
          _sum: { amountUsd: overrides.unmatchedAmountUsd ?? null },
        }),
        groupBy: jest.fn().mockResolvedValue(overrides.unmatchedBySourceAndReason ?? []),
      },
      incomeRecord: {
        count: jest.fn().mockResolvedValue(manualDraftCounts.manualIncome ?? 0),
      },
      manualCardSpendEntry: {
        count: jest.fn().mockResolvedValue(manualDraftCounts.manualCardSpend ?? 0),
      },
      monthlySalaryManualItem: {
        count: jest.fn().mockResolvedValue(manualDraftCounts.salaryManualItem ?? 0),
      },
      historicalNegativeProfit: {
        count: jest.fn().mockResolvedValue(manualDraftCounts.historicalNegativeProfit ?? 0),
      },
      syncTask: {
        groupBy: jest.fn().mockResolvedValue(overrides.syncTaskCounts ?? []),
      },
    };

    return {
      service: new SettlementPreflightService(prisma as unknown as PrismaService),
      prisma,
    };
  }

  function checkByCode(result: Awaited<ReturnType<SettlementPreflightService['check']>>, code: string) {
    const check = result.checks.find((item) => item.code === code);
    if (!check) throw new Error(`Missing check ${code}`);
    return check;
  }

  it('returns ok and canGenerate=true when no risk is found', async () => {
    const { service, prisma } = createHarness();

    const result = await service.check(settlementMonth);

    expect(result).toEqual(
      expect.objectContaining({
        settlementMonth: '2026-06-01',
        canGenerate: true,
        severity: 'ok',
        summary: {
          openUnmatchedEventCount: 0,
          missingProviderFeeRateCount: 0,
          missingExchangeRate: false,
          draftManualRecordCount: 0,
          runningOrPendingSyncTaskCount: 0,
          isLocked: false,
        },
      }),
    );
    expect(prisma.monthlyExchangeRate.findFirst).toHaveBeenCalledWith({
      where: { settlementMonth, status: { in: [CommonStatus.active, CommonStatus.confirmed] } },
      select: { id: true },
    });
    expect(prisma.cardSpendEvent.findMany).toHaveBeenCalledWith({
      where: {
        settlementMonth,
        status: CommonStatus.confirmed,
        provider: { in: [Provider.airwallex, Provider.photonpay] },
      },
      distinct: ['provider'],
      select: { provider: true },
    });
  });

  it('returns blocking when settlement month is locked', async () => {
    const { service } = createHarness({
      settlement: { status: SettlementStatus.locked },
    });

    const result = await service.check(settlementMonth);

    expect(result.canGenerate).toBe(false);
    expect(result.severity).toBe('blocking');
    expect(result.summary.isLocked).toBe(true);
    expect(checkByCode(result, 'MONTH_LOCKED')).toEqual(
      expect.objectContaining({ severity: 'blocking' }),
    );
  });

  it('returns warning and count for open unmatched events', async () => {
    const { service } = createHarness({
      unmatchedCount: 3,
      unmatchedAmountUsd: decimal('42.5'),
      unmatchedBySourceAndReason: [
        {
          sourceType: SyncTaskSourceType.affiliate_income,
          reasonCode: 'SUB_ID_NOT_MAPPED',
          _count: { _all: 2 },
        },
        {
          sourceType: SyncTaskSourceType.card_spend,
          reasonCode: 'CARD_NOT_MAPPED',
          _count: { _all: 1 },
        },
      ],
    });

    const result = await service.check(settlementMonth);

    expect(result.canGenerate).toBe(true);
    expect(result.severity).toBe('warning');
    expect(result.summary.openUnmatchedEventCount).toBe(3);
    expect(checkByCode(result, 'OPEN_UNMATCHED_EVENTS')).toEqual(
      expect.objectContaining({
        severity: 'warning',
        count: 3,
        amountUsd: '42.5',
        details: {
          bySourceTypeAndReasonCode: [
            { sourceType: SyncTaskSourceType.affiliate_income, reasonCode: 'SUB_ID_NOT_MAPPED', count: 2 },
            { sourceType: SyncTaskSourceType.card_spend, reasonCode: 'CARD_NOT_MAPPED', count: 1 },
          ],
        },
      }),
    );
  });

  it('returns blocking when USD/CNY exchange rate is missing', async () => {
    const { service } = createHarness({ exchangeRate: null });

    const result = await service.check(settlementMonth);

    expect(result.canGenerate).toBe(false);
    expect(result.severity).toBe('blocking');
    expect(result.summary.missingExchangeRate).toBe(true);
    expect(checkByCode(result, 'MISSING_USD_CNY_EXCHANGE_RATE')).toEqual(
      expect.objectContaining({ severity: 'blocking' }),
    );
  });

  it('returns blocking when confirmed API card spend misses provider fee rate', async () => {
    const { service } = createHarness({
      confirmedApiSpendProviders: [{ provider: Provider.airwallex }, { provider: Provider.photonpay }],
      activeProviderFeeRates: [{ provider: Provider.airwallex }],
    });

    const result = await service.check(settlementMonth);

    expect(result.canGenerate).toBe(false);
    expect(result.severity).toBe('blocking');
    expect(result.summary.missingProviderFeeRateCount).toBe(1);
    expect(checkByCode(result, 'MISSING_CARD_PROVIDER_FEE_RATE')).toEqual(
      expect.objectContaining({
        severity: 'blocking',
        count: 1,
        details: { missingProviders: [Provider.photonpay] },
      }),
    );
  });

  it('returns warning for draft or inactive manual data', async () => {
    const { service } = createHarness({
      manualDraftCounts: {
        manualIncome: 1,
        manualCardSpend: 2,
        salaryManualItem: 1,
        historicalNegativeProfit: 1,
      },
    });

    const result = await service.check(settlementMonth);

    expect(result.canGenerate).toBe(true);
    expect(result.severity).toBe('warning');
    expect(result.summary.draftManualRecordCount).toBe(5);
    expect(checkByCode(result, 'DRAFT_MANUAL_RECORDS')).toEqual(
      expect.objectContaining({
        severity: 'warning',
        count: 5,
        details: {
          countsByType: {
            manualIncome: 1,
            manualCardSpend: 2,
            salaryManualItem: 1,
            historicalNegativeProfit: 1,
          },
        },
      }),
    );
  });

  it('returns warning for pending or running sync tasks', async () => {
    const { service } = createHarness({
      syncTaskCounts: [
        { status: SyncTaskStatus.pending, _count: { _all: 2 } },
        { status: SyncTaskStatus.running, _count: { _all: 1 } },
      ],
    });

    const result = await service.check(settlementMonth);

    expect(result.canGenerate).toBe(true);
    expect(result.severity).toBe('warning');
    expect(result.summary.runningOrPendingSyncTaskCount).toBe(3);
    expect(checkByCode(result, 'SYNC_TASKS_IN_PROGRESS_OR_FAILED')).toEqual(
      expect.objectContaining({
        severity: 'warning',
        count: 3,
        details: { runningOrPendingCount: 3, failedCount: 0 },
      }),
    );
  });

  it('returns highest severity and blocks generation when warnings and blocking checks both exist', async () => {
    const { service } = createHarness({
      exchangeRate: null,
      unmatchedCount: 1,
      syncTaskCounts: [{ status: SyncTaskStatus.failed, _count: { _all: 1 } }],
    });

    const result = await service.check(settlementMonth);

    expect(result.canGenerate).toBe(false);
    expect(result.severity).toBe('blocking');
    expect(checkByCode(result, 'OPEN_UNMATCHED_EVENTS').severity).toBe('warning');
    expect(checkByCode(result, 'SYNC_TASKS_IN_PROGRESS_OR_FAILED')).toEqual(
      expect.objectContaining({
        severity: 'warning',
        count: 1,
        details: { runningOrPendingCount: 0, failedCount: 1 },
      }),
    );
    expect(checkByCode(result, 'MISSING_USD_CNY_EXCHANGE_RATE').severity).toBe('blocking');
  });

  it('throws a safe blocking summary without exposing check details', async () => {
    const { service } = createHarness({ exchangeRate: null });
    jest.spyOn(service, 'check').mockResolvedValue({
      settlementMonth: '2026-06-01',
      canGenerate: false,
      severity: 'blocking',
      checks: [{
        code: 'MISSING_USD_CNY_EXCHANGE_RATE',
        severity: 'blocking',
        message: 'Monthly USD/CNY exchange rate is required before salary generation.',
        details: { apiKey: 'key-value', token: 'token-value', secret: 'secret-value' },
      }],
      summary: {
        openUnmatchedEventCount: 0,
        missingProviderFeeRateCount: 0,
        missingExchangeRate: true,
        draftManualRecordCount: 0,
        runningOrPendingSyncTaskCount: 0,
        isLocked: false,
      },
    });

    let thrown: AppError | undefined;
    try {
      await service.assertCanGenerate(settlementMonth);
    } catch (error) {
      thrown = error as AppError;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown?.getResponse()).toEqual({
      code: 'SETTLEMENT_PRECHECK_FAILED',
      message: 'Settlement generation is blocked by preflight checks.',
      details: {
        settlementMonth: '2026-06-01',
        severity: 'blocking',
        blockingChecks: [{
          code: 'MISSING_USD_CNY_EXCHANGE_RATE',
          message: 'Monthly USD/CNY exchange rate is required before salary generation.',
        }],
      },
    });
    expect(JSON.stringify(thrown?.getResponse())).not.toMatch(/key-value|token-value|secret-value/);
  });

  it('rejects canGenerate=false even without blocking severity', async () => {
    const { service } = createHarness();
    const result = await service.check(settlementMonth);
    jest.spyOn(service, 'check').mockResolvedValue({ ...result, canGenerate: false, severity: 'warning' });

    await expect(service.assertCanGenerate(settlementMonth)).rejects.toMatchObject({
      code: 'SETTLEMENT_PRECHECK_FAILED',
    });
  });

  it('allows ok preflight without acknowledgement', async () => {
    const { service } = createHarness();
    await expect(service.assertCanGenerate(settlementMonth)).resolves.toEqual(
      expect.objectContaining({ canGenerate: true, severity: 'ok' }),
    );
  });

  it('allows warning preflight only with the exact current warning codes', async () => {
    const { service } = createHarness({ unmatchedCount: 1 });
    await expect(service.assertCanGenerate(settlementMonth, ['OPEN_UNMATCHED_EVENTS'])).resolves.toEqual(
      expect.objectContaining({ canGenerate: true, severity: 'warning' }),
    );
    await expect(service.assertCanGenerate(settlementMonth)).rejects.toMatchObject({
      code: 'SETTLEMENT_WARNING_ACK_REQUIRED',
    });
    await expect(service.assertCanGenerate(settlementMonth, ['OPEN_UNMATCHED_EVENTS', 'STALE'])).rejects.toMatchObject({
      code: 'SETTLEMENT_WARNING_ACK_REQUIRED',
    });
  });

  it('parses YYYY-MM and YYYY-MM-01 settlementMonth query values', () => {
    const { service } = createHarness();

    expect(service.parseSettlementMonth('2026-06')).toEqual(settlementMonth);
    expect(service.parseSettlementMonth('2026-06-01')).toEqual(settlementMonth);
    expect(() => service.parseSettlementMonth('2026-06-02')).toThrow(AppError);
  });

  it('queries only open unmatched events and pending/running/failed sync tasks', async () => {
    const { service, prisma } = createHarness();

    await service.check(settlementMonth);

    expect(prisma.syncUnmatchedEvent.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { settlementMonth, status: SyncUnmatchedEventStatus.open },
      }),
    );
    expect(prisma.syncTask.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          settlementMonth,
          status: { in: [SyncTaskStatus.pending, SyncTaskStatus.running, SyncTaskStatus.failed] },
        },
      }),
    );
  });
});
