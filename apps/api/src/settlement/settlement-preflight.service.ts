import { Injectable } from '@nestjs/common';
import {
  CommonStatus,
  Prisma,
  Provider,
  SettlementStatus,
  SyncTaskStatus,
  SyncUnmatchedEventStatus,
} from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';

const ACTIVE_RATE_STATUSES = [CommonStatus.active, CommonStatus.confirmed] as const;
const CHECK_SEVERITY_ORDER = { ok: 0, warning: 1, blocking: 2 } as const;
const API_CARD_PROVIDERS = [Provider.airwallex, Provider.photonpay] as const;

type PreflightSeverity = keyof typeof CHECK_SEVERITY_ORDER;

export type SettlementPreflightCheck = {
  code: string;
  severity: PreflightSeverity;
  message: string;
  count?: number;
  amountUsd?: string;
  details?: Record<string, unknown>;
};

export type SettlementPreflightResult = {
  settlementMonth: string;
  canGenerate: boolean;
  severity: PreflightSeverity;
  checks: SettlementPreflightCheck[];
  summary: {
    openUnmatchedEventCount: number;
    missingProviderFeeRateCount: number;
    missingExchangeRate: boolean;
    draftManualRecordCount: number;
    runningOrPendingSyncTaskCount: number;
    isLocked: boolean;
  };
};

@Injectable()
export class SettlementPreflightService {
  constructor(private readonly prisma: PrismaService) {}

  async assertCanGenerate(
    settlementMonth: Date,
    acknowledgedWarningCodes?: unknown,
  ): Promise<SettlementPreflightResult> {
    const result = await this.check(settlementMonth);
    if (!result.canGenerate || result.severity === 'blocking') {
      const blockingChecks = result.checks
        .filter((check) => check.severity === 'blocking')
        .map(({ code, message }) => ({ code, message }));

      throw new AppError(
        ERROR_CODES.SETTLEMENT_PRECHECK_FAILED,
        'Settlement generation is blocked by preflight checks.',
        {
          settlementMonth: result.settlementMonth,
          severity: result.severity,
          blockingChecks,
        },
      );
    }

    const requiredWarningCodes = result.checks
      .filter((check) => check.severity === 'warning')
      .map((check) => check.code);
    const acknowledgedCodes = Array.isArray(acknowledgedWarningCodes)
      ? acknowledgedWarningCodes.filter((code): code is string => typeof code === 'string')
      : [];
    const hasInvalidShape = acknowledgedWarningCodes !== undefined && !Array.isArray(acknowledgedWarningCodes);
    const hasInvalidCode = acknowledgedCodes.some((code) => code.trim().length === 0)
      || (Array.isArray(acknowledgedWarningCodes) && acknowledgedCodes.length !== acknowledgedWarningCodes.length);
    const hasDuplicate = new Set(acknowledgedCodes).size !== acknowledgedCodes.length;
    const requiredSet = new Set(requiredWarningCodes);
    const acknowledgedSet = new Set(acknowledgedCodes);
    const missingWarningCodes = requiredWarningCodes.filter((code) => !acknowledgedSet.has(code));
    const unknownWarningCodes = acknowledgedCodes.filter((code) => !requiredSet.has(code));

    if (
      hasInvalidShape
      || hasInvalidCode
      || hasDuplicate
      || missingWarningCodes.length > 0
      || unknownWarningCodes.length > 0
    ) {
      throw new AppError(
        ERROR_CODES.SETTLEMENT_WARNING_ACK_REQUIRED,
        'Current settlement warnings must be acknowledged exactly before generation.',
        {
          settlementMonth: result.settlementMonth,
          requiredWarningCodes,
          acknowledgedWarningCodes: acknowledgedCodes,
          missingWarningCodes,
          unknownWarningCodes,
        },
      );
    }

    return result;
  }

  async check(settlementMonth: Date): Promise<SettlementPreflightResult> {
    const [
      settlement,
      exchangeRate,
      confirmedApiSpendProviders,
      activeProviderFeeRates,
      unmatchedAggregate,
      unmatchedBySourceAndReason,
      manualDraftCounts,
      syncTaskCounts,
    ] = await Promise.all([
      this.prisma.monthlySettlement.findUnique({
        where: { settlementMonth },
        select: { status: true },
      }),
      this.prisma.monthlyExchangeRate.findFirst({
        where: { settlementMonth, status: { in: [...ACTIVE_RATE_STATUSES] } },
        select: { id: true },
      }),
      this.prisma.cardSpendEvent.findMany({
        where: {
          settlementMonth,
          status: CommonStatus.confirmed,
          provider: { in: [...API_CARD_PROVIDERS] },
        },
        distinct: ['provider'],
        select: { provider: true },
      }),
      this.prisma.monthlyCardProviderFeeRate.findMany({
        where: {
          settlementMonth,
          provider: { in: [...API_CARD_PROVIDERS] },
          status: { in: [...ACTIVE_RATE_STATUSES] },
        },
        select: { provider: true },
      }),
      this.prisma.syncUnmatchedEvent.aggregate({
        where: { settlementMonth, status: SyncUnmatchedEventStatus.open },
        _count: { _all: true },
        _sum: { amountUsd: true },
      }),
      this.prisma.syncUnmatchedEvent.groupBy({
        by: ['sourceType', 'reasonCode'],
        where: { settlementMonth, status: SyncUnmatchedEventStatus.open },
        _count: { _all: true },
        orderBy: [{ sourceType: 'asc' }, { reasonCode: 'asc' }],
      }),
      this.readManualDraftCounts(settlementMonth),
      this.prisma.syncTask.groupBy({
        by: ['status'],
        where: {
          settlementMonth,
          status: { in: [SyncTaskStatus.pending, SyncTaskStatus.running, SyncTaskStatus.failed] },
        },
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
    ]);

    const isLocked = settlement?.status === SettlementStatus.locked;
    const openUnmatchedEventCount = unmatchedAggregate._count._all;
    const confirmedProviders = confirmedApiSpendProviders.map((event) => event.provider);
    const providersWithRates = new Set(activeProviderFeeRates.map((rate) => rate.provider));
    const missingProviderFeeRates = confirmedProviders.filter((provider) => !providersWithRates.has(provider));
    const missingExchangeRate = !exchangeRate;
    const draftManualRecordCount = Object.values(manualDraftCounts).reduce((sum, count) => sum + count, 0);
    const runningOrPendingSyncTaskCount =
      countByStatus(syncTaskCounts, SyncTaskStatus.pending) + countByStatus(syncTaskCounts, SyncTaskStatus.running);
    const failedSyncTaskCount = countByStatus(syncTaskCounts, SyncTaskStatus.failed);

    const checks: SettlementPreflightCheck[] = [
      this.buildLockedCheck(isLocked),
      this.buildUnmatchedCheck(openUnmatchedEventCount, unmatchedAggregate._sum.amountUsd, unmatchedBySourceAndReason),
      this.buildExchangeRateCheck(missingExchangeRate),
      this.buildProviderFeeRateCheck(missingProviderFeeRates),
      this.buildManualDraftCheck(draftManualRecordCount, manualDraftCounts),
      this.buildSyncTaskCheck(runningOrPendingSyncTaskCount, failedSyncTaskCount),
    ];

    const severity = maxSeverity(checks.map((check) => check.severity));

    return {
      settlementMonth: formatDate(settlementMonth),
      canGenerate: severity !== 'blocking',
      severity,
      checks,
      summary: {
        openUnmatchedEventCount,
        missingProviderFeeRateCount: missingProviderFeeRates.length,
        missingExchangeRate,
        draftManualRecordCount,
        runningOrPendingSyncTaskCount,
        isLocked,
      },
    };
  }

  parseSettlementMonth(value: unknown): Date {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'settlementMonth is required.');
    }

    const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value.trim());
    if (!match || (match[3] !== undefined && match[3] !== '01')) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'settlementMonth must use YYYY-MM or YYYY-MM-01 format.');
    }

    const monthIndex = Number(match[2]) - 1;
    if (monthIndex < 0 || monthIndex > 11) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'settlementMonth must use YYYY-MM or YYYY-MM-01 format.');
    }

    return new Date(Date.UTC(Number(match[1]), monthIndex, 1, 0, 0, 0, 0));
  }

  private async readManualDraftCounts(settlementMonth: Date) {
    const [manualIncome, manualCardSpend, salaryManualItem, historicalNegativeProfit] = await Promise.all([
      this.prisma.incomeRecord.count({
        where: {
          settlementMonth,
          status: { not: CommonStatus.confirmed },
        },
      }),
      this.prisma.manualCardSpendEntry.count({
        where: {
          settlementMonth,
          status: { not: SettlementStatus.confirmed },
        },
      }),
      this.prisma.monthlySalaryManualItem.count({
        where: {
          settlementMonth,
          status: { notIn: [...ACTIVE_RATE_STATUSES] },
        },
      }),
      this.prisma.historicalNegativeProfit.count({
        where: {
          settlementMonth,
          status: { notIn: [...ACTIVE_RATE_STATUSES] },
        },
      }),
    ]);

    return {
      manualIncome,
      manualCardSpend,
      salaryManualItem,
      historicalNegativeProfit,
    };
  }

  private buildLockedCheck(isLocked: boolean): SettlementPreflightCheck {
    if (!isLocked) {
      return {
        code: 'MONTH_LOCKED',
        severity: 'ok',
        message: 'Settlement month is not locked.',
      };
    }

    return {
      code: 'MONTH_LOCKED',
      severity: 'blocking',
      message: 'Settlement month is locked and cannot be regenerated.',
      details: { isLocked },
    };
  }

  private buildUnmatchedCheck(
    count: number,
    amountUsd: Prisma.Decimal | null,
    rows: Array<{ sourceType: string; reasonCode: string; _count: { _all: number } }>,
  ): SettlementPreflightCheck {
    if (count === 0) {
      return {
        code: 'OPEN_UNMATCHED_EVENTS',
        severity: 'ok',
        message: 'No open unmatched sync events found.',
        count,
      };
    }

    return {
      code: 'OPEN_UNMATCHED_EVENTS',
      severity: 'warning',
      message: 'Open unmatched sync events may cause salary data to be understated.',
      count,
      amountUsd: decimalToString(amountUsd) ?? undefined,
      details: {
        bySourceTypeAndReasonCode: rows.map((row) => ({
          sourceType: row.sourceType,
          reasonCode: row.reasonCode,
          count: row._count._all,
        })),
      },
    };
  }

  private buildExchangeRateCheck(missingExchangeRate: boolean): SettlementPreflightCheck {
    if (!missingExchangeRate) {
      return {
        code: 'MISSING_USD_CNY_EXCHANGE_RATE',
        severity: 'ok',
        message: 'Monthly USD/CNY exchange rate is available.',
      };
    }

    return {
      code: 'MISSING_USD_CNY_EXCHANGE_RATE',
      severity: 'blocking',
      message: 'Monthly USD/CNY exchange rate is required before salary generation.',
    };
  }

  private buildProviderFeeRateCheck(missingProviders: Provider[]): SettlementPreflightCheck {
    if (missingProviders.length === 0) {
      return {
        code: 'MISSING_CARD_PROVIDER_FEE_RATE',
        severity: 'ok',
        message: 'Monthly provider fee rates are available for confirmed API card spend.',
        count: 0,
      };
    }

    return {
      code: 'MISSING_CARD_PROVIDER_FEE_RATE',
      severity: 'blocking',
      message: 'Monthly provider fee rates are required for confirmed API card spend.',
      count: missingProviders.length,
      details: { missingProviders },
    };
  }

  private buildManualDraftCheck(
    count: number,
    countsByType: Record<string, number>,
  ): SettlementPreflightCheck {
    if (count === 0) {
      return {
        code: 'DRAFT_MANUAL_RECORDS',
        severity: 'ok',
        message: 'No draft or inactive manual salary inputs found.',
        count,
      };
    }

    return {
      code: 'DRAFT_MANUAL_RECORDS',
      severity: 'warning',
      message: 'Draft or inactive manual salary inputs should be confirmed or reviewed before generation.',
      count,
      details: { countsByType },
    };
  }

  private buildSyncTaskCheck(runningOrPendingCount: number, failedCount: number): SettlementPreflightCheck {
    const count = runningOrPendingCount + failedCount;
    if (count === 0) {
      return {
        code: 'SYNC_TASKS_IN_PROGRESS_OR_FAILED',
        severity: 'ok',
        message: 'No pending, running, or failed sync tasks found for this settlement month.',
        count,
      };
    }

    return {
      code: 'SYNC_TASKS_IN_PROGRESS_OR_FAILED',
      severity: 'warning',
      message: 'Pending, running, or failed sync tasks may mean source data still needs review.',
      count,
      details: { runningOrPendingCount, failedCount },
    };
  }
}

function countByStatus(
  rows: Array<{ status: SyncTaskStatus; _count: { _all: number } }>,
  status: SyncTaskStatus,
): number {
  return rows.find((row) => row.status === status)?._count._all ?? 0;
}

function maxSeverity(severities: PreflightSeverity[]): PreflightSeverity {
  return severities.reduce<PreflightSeverity>(
    (max, current) => (CHECK_SEVERITY_ORDER[current] > CHECK_SEVERITY_ORDER[max] ? current : max),
    'ok',
  );
}

function decimalToString(value: Prisma.Decimal | null | undefined): string | null {
  return value ? value.toString() : null;
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
