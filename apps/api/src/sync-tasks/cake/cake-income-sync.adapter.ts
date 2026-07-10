import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../../common/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncUnmatchedEventsService } from '../../sync-unmatched-events/sync-unmatched-events.service';
import { SyncAdapter, SyncAdapterContext, SyncAdapterResult } from '../sync-adapter';
import { providerErrorCategory } from '../provider-request-error';
import { CakeClient, CakeConversionRecord, CakeCredentialPayload } from './cake-client';

const CAKE_SOURCE = 'cake';
const PAGE_SIZE = 2000;
const SUB_FIELDS = ['sub_id', 'subid', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5'] as const;

type NormalizedCakeRecord = {
  externalRecordId: string | null;
  incomeUsd: Prisma.Decimal;
  currency: string | null;
  occurredAt: Date | null;
  subCandidates: Array<{ subField: string; subValue: string }>;
  rawData: CakeConversionRecord;
};

type CakeAdapterPrisma = {
  subIdMapping: {
    findFirst(args: unknown): Promise<{ employeeId: string } | null>;
  };
  incomeRecord: {
    upsert(args: unknown): Promise<unknown>;
  };
};

@Injectable()
export class CakeIncomeSyncAdapter implements SyncAdapter {
  readonly adapterKey = 'affiliate_income.cake';

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: CakeClient,
    private readonly unmatchedEvents: SyncUnmatchedEventsService,
  ) {}

  async execute(context: SyncAdapterContext): Promise<SyncAdapterResult> {
    this.assertContext(context);
    const credential = parseCredentialPayload(context.credential.payload);
    const window = getCakeGmt8SettlementMonthWindow(context.settlementMonth);

    let successCount = 0;
    let failedCount = 0;
    let startAtRow = 1;

    try {
      while (true) {
        const response = await this.client.getConversions({
          credential,
          startDate: window.startDate,
          endDate: window.endDate,
          startAtRow,
          rowLimit: PAGE_SIZE,
        });
        const records = response.conversions ?? [];

        for (const raw of records) {
          const normalized = normalizeCakeRecord(raw);
          const result = await this.upsertIncomeRecord(normalized, context);
          if (result) successCount += 1;
          else failedCount += 1;
        }

        if (records.length < PAGE_SIZE) break;
        startAtRow += PAGE_SIZE;
      }
    } catch (error) {
      failedCount += 1;
      const errorMessage = sanitizeErrorMessage(error instanceof Error ? error.message : 'CAKE API request failed.', credential);
      return { ...this.result('failed', successCount, failedCount, window, errorMessage, context), errorCategory: providerErrorCategory(error) };
    }

    const status = successCount > 0 && failedCount === 0 ? 'completed' : 'failed';
    const message = `CAKE income sync finished: successCount=${successCount}, failedCount=${failedCount}.`;
    return this.result(status, successCount, failedCount, window, message, context);
  }

  private result(
    status: 'completed' | 'failed',
    successCount: number,
    failedCount: number,
    window: ReturnType<typeof getCakeGmt8SettlementMonthWindow>,
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
        source: CAKE_SOURCE,
        pulledThirdPartyData: true,
        successCount,
        failedCount,
        settlementMonth: context.settlementMonth.toISOString().slice(0, 10),
        cakeRequest: {
          startDate: window.startDate,
          endDate: window.endDate,
          startInclusiveUtc: window.startInclusiveUtc.toISOString(),
          endExclusiveUtc: window.endExclusiveUtc.toISOString(),
          timezone: 'GMT+8',
        },
      },
    };
  }

  private async upsertIncomeRecord(record: NormalizedCakeRecord, context: SyncAdapterContext): Promise<boolean> {
    if (!record.externalRecordId) {
      await this.recordUnmatchedIncome(record, context, 'UNKNOWN', 'CAKE conversion is missing external record id.');
      return false;
    }
    if (record.currency !== 'USD') {
      await this.recordUnmatchedIncome(record, context, 'INVALID_CURRENCY', 'CAKE conversion currency is not USD.');
      return false;
    }
    if (record.subCandidates.length === 0) {
      await this.recordUnmatchedIncome(record, context, 'SUB_ID_MISSING', 'CAKE conversion has no SUB candidate.');
      return false;
    }

    const mapping = await this.findMapping(context, record.subCandidates);
    if (!mapping) {
      await this.recordUnmatchedIncome(record, context, 'SUB_ID_NOT_MAPPED', 'CAKE conversion SUB is not mapped to an employee.');
      return false;
    }

    await this.db().incomeRecord.upsert({
      where: { source_externalRecordId: { source: CAKE_SOURCE, externalRecordId: record.externalRecordId } },
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
        source: CAKE_SOURCE,
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
    record: NormalizedCakeRecord,
    context: SyncAdapterContext,
    reasonCode: string,
    reasonMessage: string,
  ) {
    const primarySub = record.subCandidates[0];
    await this.unmatchedEvents.recordUnmatchedEvent({
      settlementMonth: context.settlementMonth,
      sourceType: SyncTaskSourceType.affiliate_income,
      taskType: SyncTaskType.affiliate_income,
      platform: SyncTaskPlatform.cake,
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
      rawSafeData: buildCakeRawSafeData(record),
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
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE adapter only supports affiliate_income sync tasks.');
    }
    if (context.platform !== SyncTaskPlatform.cake) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'affiliateAccount.platform must be cake.');
    }
    if (!context.affiliateAccountId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'affiliateAccountId is required for CAKE income sync.');
    }
  }

  private db(): CakeAdapterPrisma {
    return this.prisma as unknown as CakeAdapterPrisma;
  }
}

export function getCakeGmt8SettlementMonthWindow(settlementMonth: Date) {
  // CAKE date filters are sent as Beijing calendar dates. The UTC bounds document the exact GMT+8 month window.
  const startInclusiveUtc = new Date(Date.UTC(settlementMonth.getUTCFullYear(), settlementMonth.getUTCMonth(), 1, -8, 0, 0, 0));
  const endExclusiveUtc = new Date(Date.UTC(settlementMonth.getUTCFullYear(), settlementMonth.getUTCMonth() + 1, 1, -8, 0, 0, 0));
  const endInclusiveDate = new Date(Date.UTC(settlementMonth.getUTCFullYear(), settlementMonth.getUTCMonth() + 1, 0));

  return {
    startInclusiveUtc,
    endExclusiveUtc,
    startDate: formatDate(settlementMonth),
    endDate: formatDate(endInclusiveDate),
  };
}

export function normalizeCakeRecord(raw: CakeConversionRecord): NormalizedCakeRecord {
  const externalRecordId = firstNonBlank(raw.conversion_id, raw.conversionId, raw.ConversionID, raw.transaction_id, raw.transactionId, raw.id);
  const currency = firstNonBlank(raw.currency, raw.currency_id, raw.currencyId, raw.Currency)?.toUpperCase() ?? null;
  const revenue = firstValue(raw.revenue, raw.payout, raw.price, raw.amount, raw.commission, raw.Revenue, raw.Payout);
  const subCandidates = SUB_FIELDS.flatMap((subField) => {
    const subValue = firstNonBlank(raw[subField], raw[toPascalSubField(subField)]);
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

function parseCredentialPayload(payload: unknown): CakeCredentialPayload {
  if (!payload || typeof payload !== 'object') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE credential payload is required.');
  }
  const record = payload as Record<string, unknown>;
  const apiKey = asNonBlankString(record.apiKey);
  const baseUrl = asNonBlankString(record.baseUrl);
  if (!apiKey) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE credential apiKey is required.');
  if (!baseUrl) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE credential baseUrl is required.');

  return {
    apiKey,
    baseUrl,
    conversionsPath: asNonBlankString(record.conversionsPath) ?? undefined,
    affiliateId: asNonBlankString(record.affiliateId) ?? undefined,
    campaignId: asNonBlankString(record.campaignId) ?? undefined,
    offerId: asNonBlankString(record.offerId) ?? undefined,
  };
}

function firstNonBlank(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = asNonBlankString(value);
    if (normalized) return normalized;
  }
  return null;
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function asNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseDate(value: unknown): Date | null {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildCakeRawSafeData(record: NormalizedCakeRecord): Prisma.InputJsonObject {
  const raw = record.rawData;
  const safe: Record<string, Prisma.InputJsonValue | undefined> = {
    conversionId: record.externalRecordId ?? undefined,
    transactionId: firstNonBlank(raw.transaction_id, raw.transactionId) ?? undefined,
    status: firstNonBlank(raw.status, raw.Status, raw.conversionStatus, raw.ConversionStatus) ?? undefined,
    currency: record.currency ?? undefined,
    amount: record.incomeUsd.toString(),
    conversionTime: record.occurredAt?.toISOString() ?? firstNonBlank(raw.conversion_time, raw.conversionTime, raw.conversion_date, raw.conversionDate) ?? undefined,
  };
  for (const candidate of record.subCandidates) safe[candidate.subField] = candidate.subValue;
  return compactJsonObject(safe);
}

function compactJsonObject(value: Record<string, Prisma.InputJsonValue | undefined>): Prisma.InputJsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined && child !== null)) as Prisma.InputJsonObject;
}

function toPascalSubField(subField: string): string {
  return subField
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sanitizeErrorMessage(message: string, credential: CakeCredentialPayload): string {
  let sanitized = message.replace(/([?&]api_key=)[^&\s]+/gi, '$1[REDACTED]');
  sanitized = sanitized.split(credential.apiKey).join('[REDACTED]');
  return sanitized;
}
