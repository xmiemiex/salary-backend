import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../../common/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncUnmatchedEventsService } from '../../sync-unmatched-events/sync-unmatched-events.service';
import { SyncAdapter, SyncAdapterContext, SyncAdapterResult } from '../sync-adapter';
import { providerErrorCategory } from '../provider-request-error';
import { EverflowClient, EverflowConversionRecord, EverflowCredentialPayload } from './everflow-client';

const EVERFLOW_SOURCE = 'everflow';
const GMT8_TIMEZONE_ID = 20;
const PAGE_SIZE = 2000;
const SUB_FIELDS = ['sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'sub6', 'sub7', 'sub8', 'sub9', 'sub10'] as const;

type NormalizedEverflowRecord = {
  externalRecordId: string | null;
  incomeUsd: Prisma.Decimal;
  currency: string | null;
  occurredAt: Date | null;
  subCandidates: Array<{ subField: string; subValue: string }>;
  rawData: EverflowConversionRecord;
};

type EverflowAdapterPrisma = {
  subIdMapping: {
    findFirst(args: unknown): Promise<{ employeeId: string } | null>;
  };
  incomeRecord: {
    upsert(args: unknown): Promise<unknown>;
  };
};

@Injectable()
export class EverflowIncomeSyncAdapter implements SyncAdapter {
  readonly adapterKey = 'affiliate_income.everflow';

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: EverflowClient,
    private readonly unmatchedEvents: SyncUnmatchedEventsService,
  ) {}

  async execute(context: SyncAdapterContext): Promise<SyncAdapterResult> {
    this.assertContext(context);
    const credential = parseCredentialPayload(context.credential.payload);
    const window = getGmt8SettlementMonthWindow(context.settlementMonth);

    let successCount = 0;
    let failedCount = 0;
    let page = 1;

    try {
      while (true) {
        const response = await this.client.searchAffiliateConversions({
          credential,
          from: window.from,
          to: window.to,
          timezoneId: GMT8_TIMEZONE_ID,
          page,
          pageSize: PAGE_SIZE,
        });
        const records = response.conversions ?? [];

        for (const raw of records) {
          const normalized = normalizeEverflowRecord(raw);
          const result = await this.upsertIncomeRecord(normalized, context);
          if (result) successCount += 1;
          else failedCount += 1;
        }

        const paging = response.paging;
        const totalCount = paging?.total_count ?? records.length;
        const pageSize = paging?.page_size ?? PAGE_SIZE;
        const currentPage = paging?.page ?? page;
        if (currentPage * pageSize >= totalCount || records.length === 0) break;
        page += 1;
      }
    } catch (error) {
      failedCount += 1;
      const errorMessage = error instanceof Error ? error.message : 'Everflow API request failed.';
      return { ...this.result('failed', successCount, failedCount, window, errorMessage, context), errorCategory: providerErrorCategory(error) };
    }

    const status = successCount > 0 && failedCount === 0 ? 'completed' : 'failed';
    const message = `Everflow income sync finished: successCount=${successCount}, failedCount=${failedCount}.`;
    return this.result(status, successCount, failedCount, window, message, context);
  }

  private result(
    status: 'completed' | 'failed',
    successCount: number,
    failedCount: number,
    window: ReturnType<typeof getGmt8SettlementMonthWindow>,
    message: string,
    context: SyncAdapterContext,
  ): SyncAdapterResult {
    return {
      status,
      successCount,
      failedCount,
      message,
      errorMessage: status === 'failed' ? message : null,
      resultPayload: {
        adapterKey: this.adapterKey,
        source: EVERFLOW_SOURCE,
        pulledThirdPartyData: true,
        successCount,
        failedCount,
        settlementMonth: context.settlementMonth.toISOString().slice(0, 10),
        everflowRequest: {
          from: window.from,
          to: window.to,
          timezoneId: GMT8_TIMEZONE_ID,
        },
      },
    };
  }

  private async upsertIncomeRecord(record: NormalizedEverflowRecord, context: SyncAdapterContext): Promise<boolean> {
    if (!record.externalRecordId) {
      await this.recordUnmatchedIncome(record, context, 'UNKNOWN', 'Everflow conversion is missing external record id.');
      return false;
    }
    if (record.currency !== 'USD') {
      await this.recordUnmatchedIncome(record, context, 'INVALID_CURRENCY', 'Everflow conversion currency is not USD.');
      return false;
    }
    if (record.subCandidates.length === 0) {
      await this.recordUnmatchedIncome(record, context, 'SUB_ID_MISSING', 'Everflow conversion has no SUB candidate.');
      return false;
    }

    const mapping = await this.findMapping(context, record.subCandidates);
    if (!mapping) {
      await this.recordUnmatchedIncome(record, context, 'SUB_ID_NOT_MAPPED', 'Everflow conversion SUB is not mapped to an employee.');
      return false;
    }

    await this.db().incomeRecord.upsert({
      where: { source_externalRecordId: { source: EVERFLOW_SOURCE, externalRecordId: record.externalRecordId } },
      update: {
        affiliateAccountId: context.affiliateAccountId,
        employeeId: mapping.employeeId,
        settlementMonth: context.settlementMonth,
        subField: mapping.subField,
        subValue: mapping.subValue,
        incomeUsd: record.incomeUsd,
        rawData: record.rawData as Prisma.InputJsonObject,
        status: CommonStatus.confirmed,
        importedBy: context.requestedBy,
      },
      create: {
        source: EVERFLOW_SOURCE,
        externalRecordId: record.externalRecordId,
        affiliateAccountId: context.affiliateAccountId,
        employeeId: mapping.employeeId,
        settlementMonth: context.settlementMonth,
        subField: mapping.subField,
        subValue: mapping.subValue,
        incomeUsd: record.incomeUsd,
        rawData: record.rawData as Prisma.InputJsonObject,
        status: CommonStatus.confirmed,
        importedBy: context.requestedBy,
      },
    });
    return true;
  }

  private async recordUnmatchedIncome(
    record: NormalizedEverflowRecord,
    context: SyncAdapterContext,
    reasonCode: string,
    reasonMessage: string,
  ) {
    const primarySub = record.subCandidates[0];
    await this.unmatchedEvents.recordUnmatchedEvent({
      settlementMonth: context.settlementMonth,
      sourceType: SyncTaskSourceType.affiliate_income,
      taskType: SyncTaskType.affiliate_income,
      platform: SyncTaskPlatform.everflow,
      affiliateAccountId: context.affiliateAccountId,
      syncTaskId: context.taskId,
      thirdPartyEventId: record.externalRecordId,
      reasonCode,
      reasonMessage,
      subField: primarySub?.subField,
      subValue: primarySub?.subValue,
      amountUsd: record.currency === 'USD' ? record.incomeUsd : null,
      currency: record.currency,
      occurredAt: record.occurredAt,
      rawSafeData: buildEverflowRawSafeData(record),
    });
  }

  private async findMapping(context: SyncAdapterContext, candidates: Array<{ subField: string; subValue: string }>) {
    for (const candidate of candidates) {
      const mapping = await this.db().subIdMapping.findFirst({
        where: {
          affiliateAccountId: context.affiliateAccountId,
          subField: candidate.subField,
          subValue: candidate.subValue,
          effectiveMonth: context.settlementMonth,
          status: CommonStatus.active,
        },
        select: { employeeId: true },
      });
      if (mapping) return { ...candidate, employeeId: mapping.employeeId };
    }
    return null;
  }

  private assertContext(context: SyncAdapterContext) {
    if (context.sourceType !== SyncTaskSourceType.affiliate_income || context.taskType !== SyncTaskType.affiliate_income) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Everflow adapter only supports affiliate_income sync tasks.');
    }
    if (context.platform !== SyncTaskPlatform.everflow) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'affiliateAccount.platform must be everflow.');
    }
    if (!context.affiliateAccountId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'affiliateAccountId is required for Everflow income sync.');
    }
  }

  private db(): EverflowAdapterPrisma {
    return this.prisma as unknown as EverflowAdapterPrisma;
  }
}

export function getGmt8SettlementMonthWindow(settlementMonth: Date) {
  const startUtc = new Date(Date.UTC(settlementMonth.getUTCFullYear(), settlementMonth.getUTCMonth(), 1, -8, 0, 0, 0));
  const endUtc = new Date(Date.UTC(settlementMonth.getUTCFullYear(), settlementMonth.getUTCMonth() + 1, 1, -8, 0, 0, 0));
  const inclusiveToDate = new Date(Date.UTC(settlementMonth.getUTCFullYear(), settlementMonth.getUTCMonth() + 1, 0));

  return {
    startInclusiveUtc: startUtc,
    endExclusiveUtc: endUtc,
    from: formatDate(settlementMonth),
    to: formatDate(inclusiveToDate),
    timezoneId: GMT8_TIMEZONE_ID,
  };
}

export function normalizeEverflowRecord(raw: EverflowConversionRecord): NormalizedEverflowRecord {
  const externalRecordId = asNonBlankString(raw.conversion_id) ?? asNonBlankString(raw.transaction_id) ?? null;
  const currency = asNonBlankString(raw.currency_id);
  const revenue = raw.revenue;
  const subCandidates = SUB_FIELDS.flatMap((subField) => {
    const subValue = asNonBlankString(raw[subField]);
    return subValue ? [{ subField, subValue }] : [];
  });

  return {
    externalRecordId,
    incomeUsd: new Prisma.Decimal(typeof revenue === 'number' || typeof revenue === 'string' ? revenue : 0),
    currency,
    occurredAt: parseDate(firstValue(raw.conversion_time, raw.conversionTime, raw.conversion_date, raw.conversionDate, raw.created_at, raw.createdAt)),
    subCandidates,
    rawData: raw,
  };
}

function parseCredentialPayload(payload: unknown): EverflowCredentialPayload {
  if (!payload || typeof payload !== 'object') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Everflow credential payload is required.');
  }
  const record = payload as Record<string, unknown>;
  const apiKey = asNonBlankString(record.apiKey);
  if (!apiKey) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Everflow credential apiKey is required.');

  return {
    apiKey,
    baseUrl: asNonBlankString(record.baseUrl) ?? undefined,
  };
}

function asNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function parseDate(value: unknown): Date | null {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildEverflowRawSafeData(record: NormalizedEverflowRecord): Prisma.InputJsonObject {
  const raw = record.rawData;
  const safe: Record<string, Prisma.InputJsonValue | undefined> = {
    conversionId: record.externalRecordId ?? undefined,
    transactionId: asNonBlankString(raw.transaction_id) ?? undefined,
    status: asNonBlankString(raw.status) ?? asNonBlankString(raw.conversion_status) ?? undefined,
    currency: record.currency ?? undefined,
    amount: record.incomeUsd.toString(),
    conversionTime: record.occurredAt?.toISOString() ?? asNonBlankString(raw.conversion_time) ?? asNonBlankString(raw.conversionTime) ?? undefined,
  };
  for (const candidate of record.subCandidates) safe[candidate.subField] = candidate.subValue;
  return compactJsonObject(safe);
}

function compactJsonObject(value: Record<string, Prisma.InputJsonValue | undefined>): Prisma.InputJsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined && child !== null)) as Prisma.InputJsonObject;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
