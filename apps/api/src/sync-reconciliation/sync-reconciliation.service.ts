import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma, Provider, SettlementStatus } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { parseMonthStart, requireNonBlank } from '../base-data/base-data.utils';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';

const ZERO = new Prisma.Decimal(0);
const AFFILIATE_SOURCES = ['everflow', 'cake'] as const;
const SECRET_FIELD_PATTERN = /apiKey|token|secret|clientId|merchantId|authorization|signature|password|encryptedPayload/i;
const UNMATCHED_LIMITATION =
  'Current API sync adapters skip unmapped third-party records before writing events, so this endpoint only shows unassigned records already present in the database and is not a complete list of third-party records pulled from APIs but not matched.';

export type AffiliateIncomeReconciliationQuery = {
  settlementMonth?: string;
  affiliateAccountId?: string;
  employeeId?: string;
  subId?: string;
  page?: string;
  pageSize?: string;
};

export type CardSpendReconciliationQuery = {
  settlementMonth?: string;
  provider?: string;
  employeeId?: string;
  page?: string;
  pageSize?: string;
};

export type UnmatchedReconciliationQuery = {
  settlementMonth?: string;
  type?: 'affiliate_income' | 'card_spend' | 'all';
};

type MonthlySummaryQuery = {
  settlementMonth?: string;
};

type DecimalLike = Prisma.Decimal | string | number | null | undefined;

@Injectable()
export class SyncReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async affiliateIncome(query: AffiliateIncomeReconciliationQuery) {
    const settlementMonth = parseRequiredMonth(query.settlementMonth);
    const pagination = parsePagination(query);
    const where: Prisma.IncomeRecordWhereInput = {
      settlementMonth,
      source: { in: [...AFFILIATE_SOURCES] },
      affiliateAccountId: optionalString(query.affiliateAccountId),
      employeeId: optionalString(query.employeeId),
      subValue: optionalString(query.subId),
    };

    const [total, records, aggregate, matchedAggregate, matchedCount] = await this.prisma.$transaction([
      this.prisma.incomeRecord.count({ where }),
      this.prisma.incomeRecord.findMany({
        where,
        include: {
          affiliateAccount: { select: { id: true, platform: true, accountCode: true, accountName: true } },
          employee: { select: { id: true, name: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.pageSize,
      }),
      this.prisma.incomeRecord.aggregate({ where, _sum: { incomeUsd: true }, _count: { _all: true } }),
      this.prisma.incomeRecord.aggregate({
        where: { ...where, employeeId: { not: null } },
        _sum: { incomeUsd: true },
      }),
      this.prisma.incomeRecord.count({ where: { ...where, employeeId: { not: null } } }),
    ]);

    const totalRevenueUsd = decimal(aggregate._sum.incomeUsd);
    const matchedRevenueUsd = decimal(matchedAggregate._sum.incomeUsd);

    return {
      items: records.map((record) => ({
        id: record.id,
        settlementMonth: formatDate(record.settlementMonth),
        affiliateAccountId: record.affiliateAccountId,
        affiliateAccountName: record.affiliateAccount?.accountName ?? record.affiliateAccount?.accountCode ?? null,
        affiliateAccountCode: record.affiliateAccount?.accountCode ?? null,
        platform: normalizeAffiliatePlatform(record.affiliateAccount?.platform ?? record.source),
        thirdPartyConversionId: record.externalRecordId,
        subId: record.subValue,
        subField: record.subField,
        employeeId: record.employeeId,
        employeeName: record.employee?.name ?? null,
        revenueUsd: decimalToString(record.incomeUsd),
        conversionTime: safeRawDate(record.rawData, ['conversion_unix_timestamp', 'conversion_time', 'conversionTime', 'event_time', 'eventTime']),
        eventTime: safeRawDate(record.rawData, ['event_time', 'eventTime', 'conversion_time', 'conversionTime']),
        rawStatus: safeRawString(record.rawData, ['status', 'conversion_status', 'conversionStatus']),
        syncTaskId: null,
        importedBy: record.importedBy,
        createdAt: record.createdAt,
      })),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      summary: {
        totalRevenueUsd: decimalToString(totalRevenueUsd),
        matchedRevenueUsd: decimalToString(matchedRevenueUsd),
        unmatchedRevenueUsd: decimalToString(totalRevenueUsd.minus(matchedRevenueUsd)),
        eventCount: aggregate._count._all,
        matchedCount,
        unmatchedCount: aggregate._count._all - matchedCount,
      },
    };
  }

  async cardSpend(query: CardSpendReconciliationQuery) {
    const settlementMonth = parseRequiredMonth(query.settlementMonth);
    const pagination = parsePagination(query);
    const provider = parseOptionalProvider(query.provider);
    const where: Prisma.CardSpendEventWhereInput = {
      settlementMonth,
      provider,
      employeeId: optionalString(query.employeeId),
    };

    const [total, events, aggregate, matchedAggregate, matchedCount] = await this.prisma.$transaction([
      this.prisma.cardSpendEvent.count({ where }),
      this.prisma.cardSpendEvent.findMany({
        where,
        include: { employee: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.pageSize,
      }),
      this.prisma.cardSpendEvent.aggregate({ where, _sum: { spendUsd: true }, _count: { _all: true } }),
      this.prisma.cardSpendEvent.aggregate({
        where: { ...where, employeeId: { not: null } },
        _sum: { spendUsd: true },
      }),
      this.prisma.cardSpendEvent.count({ where: { ...where, employeeId: { not: null } } }),
    ]);

    const totalSpendUsd = decimal(aggregate._sum.spendUsd);
    const matchedSpendUsd = decimal(matchedAggregate._sum.spendUsd);

    return {
      items: events.map((event) => {
        const cardDisplay = safeCardDisplay(event.rawData);
        return {
          id: event.id,
          settlementMonth: formatDate(event.settlementMonth),
          provider: event.provider,
          employeeId: event.employeeId,
          employeeName: event.employee?.name ?? null,
          cardId: event.cardId,
          cardLast4: cardDisplay.cardLast4,
          cardEmail: cardDisplay.cardEmail,
          transactionId: event.externalEventId,
          transactionAt: event.transactionAt,
          settledAt: event.settledAt ?? event.sourceUpdatedAt ?? event.createdAt,
          amountUsd: decimalToString(event.spendUsd),
          status: event.status,
          settleStatus: event.sourceStatus,
          syncTaskId: null,
          importedBy: importedBy(event),
          createdAt: event.createdAt,
        };
      }),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      summary: {
        totalSpendUsd: decimalToString(totalSpendUsd),
        matchedSpendUsd: decimalToString(matchedSpendUsd),
        unmatchedSpendUsd: decimalToString(totalSpendUsd.minus(matchedSpendUsd)),
        eventCount: aggregate._count._all,
        matchedCount,
        unmatchedCount: aggregate._count._all - matchedCount,
      },
    };
  }

  async monthlyEmployeeSummary(query: MonthlySummaryQuery) {
    const settlementMonth = parseRequiredMonth(query.settlementMonth);
    const [employees, incomes, apiSpends, manualSpends, unmatchedIncomeCount, unmatchedCardSpendCount] =
      await this.prisma.$transaction([
        this.prisma.employee.findMany({
          where: { status: CommonStatus.active },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.incomeRecord.groupBy({
          by: ['employeeId'],
          where: { settlementMonth, source: { in: [...AFFILIATE_SOURCES] }, employeeId: { not: null } },
          orderBy: { employeeId: 'asc' },
          _sum: { incomeUsd: true },
        }),
        this.prisma.cardSpendEvent.groupBy({
          by: ['employeeId'],
          where: { settlementMonth, employeeId: { not: null } },
          orderBy: { employeeId: 'asc' },
          _sum: { spendUsd: true },
        }),
        this.prisma.manualCardSpendEntry.groupBy({
          by: ['employeeId'],
          where: {
            settlementMonth,
            status: SettlementStatus.confirmed,
          },
          orderBy: { employeeId: 'asc' },
          _sum: { actualSpendUsd: true },
        }),
        this.prisma.incomeRecord.count({
          where: { settlementMonth, source: { in: [...AFFILIATE_SOURCES] }, employeeId: null },
        }),
        this.prisma.cardSpendEvent.count({ where: { settlementMonth, employeeId: null } }),
      ]);

    const incomeByEmployee = decimalMap(incomes, 'incomeUsd');
    const apiSpendByEmployee = decimalMap(apiSpends, 'spendUsd');
    const manualSpendByEmployee = decimalMap(manualSpends, 'actualSpendUsd');
    const employeeIds = new Set<string>([
      ...employees.map((employee) => employee.id),
      ...incomeByEmployee.keys(),
      ...apiSpendByEmployee.keys(),
      ...manualSpendByEmployee.keys(),
    ]);
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]));

    return [...employeeIds].sort((a, b) => (employeeById.get(a)?.name ?? a).localeCompare(employeeById.get(b)?.name ?? b)).map((employeeId) => {
      const affiliateRevenueUsd = incomeByEmployee.get(employeeId) ?? ZERO;
      const apiCardSpendUsd = apiSpendByEmployee.get(employeeId) ?? ZERO;
      const manualCardSpendUsd = manualSpendByEmployee.get(employeeId) ?? ZERO;
      const warnings = [
        ...(unmatchedIncomeCount > 0 ? ['missingSubMapping'] : []),
        ...(unmatchedCardSpendCount > 0 ? ['missingCardMapping'] : []),
      ];

      return {
        employeeId,
        employeeName: employeeById.get(employeeId)?.name ?? null,
        affiliateRevenueUsd: decimalToString(affiliateRevenueUsd),
        apiCardSpendUsd: decimalToString(apiCardSpendUsd),
        manualCardSpendUsd: decimalToString(manualCardSpendUsd),
        rawGrossProfitUsd: decimalToString(affiliateRevenueUsd.minus(apiCardSpendUsd).minus(manualCardSpendUsd)),
        unmatchedFlags: warnings,
        warnings,
      };
    });
  }

  async unmatched(query: UnmatchedReconciliationQuery) {
    const settlementMonth = parseRequiredMonth(query.settlementMonth);
    const type = query.type ?? 'all';
    if (!['affiliate_income', 'card_spend', 'all'].includes(type)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'type must be affiliate_income, card_spend, or all.');
    }

    const incomeEvents =
      type === 'card_spend'
        ? []
        : await this.prisma.incomeRecord.findMany({
            where: { settlementMonth, source: { in: [...AFFILIATE_SOURCES] }, employeeId: null },
            include: {
              affiliateAccount: { select: { id: true, platform: true, accountCode: true, accountName: true } },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          });
    const cardSpendEvents =
      type === 'affiliate_income'
        ? []
        : await this.prisma.cardSpendEvent.findMany({
            where: { settlementMonth, employeeId: null },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          });

    return {
      limitation: UNMATCHED_LIMITATION,
      warnings: [UNMATCHED_LIMITATION],
      affiliateIncomeEvents: incomeEvents.map((record) => ({
        type: 'affiliate_income',
        reason: record.subValue ? 'SUB_ID_NOT_MAPPED' : 'SUB_ID_MISSING',
        id: record.id,
        settlementMonth: formatDate(record.settlementMonth),
        affiliateAccountId: record.affiliateAccountId,
        affiliateAccountName: record.affiliateAccount?.accountName ?? record.affiliateAccount?.accountCode ?? null,
        platform: normalizeAffiliatePlatform(record.affiliateAccount?.platform ?? record.source),
        thirdPartyConversionId: record.externalRecordId,
        subId: record.subValue,
        revenueUsd: decimalToString(record.incomeUsd),
        syncTaskId: null,
        importedBy: record.importedBy,
        createdAt: record.createdAt,
      })),
      cardSpendEvents: cardSpendEvents.map((event) => ({
        type: 'card_spend',
        reason: event.cardId ? 'CARD_NOT_MAPPED' : 'CARD_ID_MISSING',
        id: event.id,
        settlementMonth: formatDate(event.settlementMonth),
        provider: event.provider,
        cardId: event.cardId,
        ...safeCardDisplay(event.rawData),
        transactionId: event.externalEventId,
        transactionAt: event.transactionAt,
        amountUsd: decimalToString(event.spendUsd),
        status: event.status,
        settleStatus: event.sourceStatus,
        syncTaskId: null,
        importedBy: importedBy(event),
        createdAt: event.createdAt,
      })),
    };
  }
}

function parseRequiredMonth(value: unknown): Date {
  return parseMonthStart(requireNonBlank(value, 'settlementMonth'), 'settlementMonth');
}

function parsePagination(query: { page?: string; pageSize?: string }) {
  const page = parsePositiveInteger(query.page, 1, 1, 100000);
  const pageSize = parsePositiveInteger(query.pageSize, 50, 1, 500);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function parsePositiveInteger(value: unknown, defaultValue: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `pagination value must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseOptionalProvider(value: unknown): Provider | undefined {
  const provider = optionalString(value);
  if (!provider) return undefined;
  if (provider !== Provider.airwallex && provider !== Provider.photonpay) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'provider must be airwallex or photonpay.');
  }
  return provider;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeAffiliatePlatform(value: string | null): 'everflow' | 'cake' | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'everflow' || normalized === 'cake') return normalized;
  return null;
}

function decimal(value: DecimalLike): Prisma.Decimal {
  if (!value) return ZERO;
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function decimalToString(value: DecimalLike): string {
  return decimal(value).toString();
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function decimalMap<T extends { employeeId: string | null; _sum?: Record<string, Prisma.Decimal | null | undefined> }>(
  rows: T[],
  sumField: string,
): Map<string, Prisma.Decimal> {
  const result = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    if (row.employeeId) result.set(row.employeeId, decimal(row._sum?.[sumField]));
  }
  return result;
}

function importedBy(event: unknown): string | null {
  const record = event as { importedBy?: string | null };
  return record.importedBy ?? null;
}

function safeCardDisplay(rawData: Prisma.JsonValue | null) {
  return {
    cardLast4: safeRawString(rawData, ['cardLast4', 'card_last4', 'last4', 'card_number_last4']),
    cardEmail: safeRawString(rawData, ['cardEmail', 'card_email', 'email', 'holderEmail', 'holder_email']),
  };
}

function safeRawDate(rawData: Prisma.JsonValue | null, allowedKeys: string[]): string | null {
  const value = safeRawValue(rawData, allowedKeys);
  if (typeof value === 'number') {
    const date = new Date(value > 100000000000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value.trim() : date.toISOString();
  }
  return null;
}

function safeRawString(rawData: Prisma.JsonValue | null, allowedKeys: string[]): string | null {
  const value = safeRawValue(rawData, allowedKeys);
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function safeRawValue(rawData: Prisma.JsonValue | null, allowedKeys: string[]): unknown {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) return null;
  const record = rawData as Record<string, unknown>;
  for (const key of allowedKeys) {
    if (SECRET_FIELD_PATTERN.test(key)) continue;
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}
