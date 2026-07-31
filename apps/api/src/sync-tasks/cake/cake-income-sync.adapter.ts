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
const PAYABLE_DISPOSITIONS = new Set(['approved']);
const NON_FINAL_DISPOSITIONS = new Set(['pending', 'rejected', 'invalid', 'cancelled', 'canceled', 'void', 'declined']);

export type NormalizedCakeRecord = {
  externalRecordId: string | null;
  payoutUsd: Prisma.Decimal;
  payoutField: string | null;
  payoutValid: boolean;
  currency: string;
  occurredAt: Date | null;
  timestampHasExplicitTimezone: boolean;
  disposition: string | null;
  subCandidates: Array<{ subField: string; subValue: string }>;
  rawData: CakeConversionRecord;
};

type CakeMapping = { subField: string; subValue: string; employeeId: string };

type CakeAdapterPrisma = {
  subIdMapping: {
    findMany(args: unknown): Promise<CakeMapping[]>;
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
    const affiliateId = context.affiliateAccountCode as string;
    const window = getCakeGmt8SettlementMonthWindow(context.settlementMonth);
    const seenExternalIds = new Set<string>();
    const seenPageSignatures = new Set<string>();

    let pulledCount = 0;
    let attributedCount = 0;
    let unmatchedCount = 0;
    let duplicateCount = 0;
    let pageCount = 0;
    let startAtRow = 1;

    try {
      while (true) {
        const response = await this.client.getConversions({
          credential,
          affiliateId,
          startDate: window.startDate,
          endDate: window.endDate,
          startAtRow,
          rowLimit: PAGE_SIZE,
        });
        const records = response.conversions ?? [];
        pageCount += 1;
        pulledCount += records.length;

        const pageSignature = records
          .map((raw) => firstNonBlank(raw.conversion_id, raw.conversionId, raw.ConversionID) ?? '?')
          .join('|');
        if (records.length > 0 && seenPageSignatures.has(pageSignature)) {
          duplicateCount += records.length;
          break;
        }
        if (records.length > 0) seenPageSignatures.add(pageSignature);

        for (const raw of records) {
          const normalized = normalizeCakeRecord(raw);
          if (normalized.externalRecordId && seenExternalIds.has(normalized.externalRecordId)) {
            duplicateCount += 1;
            continue;
          }
          if (normalized.externalRecordId) seenExternalIds.add(normalized.externalRecordId);

          const result = await this.upsertIncomeRecord(normalized, context, window);
          if (result) attributedCount += 1;
          else unmatchedCount += 1;
        }

        if (
          records.length < PAGE_SIZE ||
          (response.rowCount !== null && startAtRow + records.length > response.rowCount) ||
          records.length === 0
        ) {
          break;
        }
        startAtRow += PAGE_SIZE;
      }
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(
        error instanceof Error ? error.message : 'CAKE API request failed.',
        credential,
      );
      return {
        ...this.result(
          'failed',
          attributedCount,
          1,
          window,
          errorMessage,
          context,
          { pulledCount, unmatchedCount, duplicateCount, pageCount },
        ),
        errorCategory: providerErrorCategory(error),
      };
    }

    const message =
      `CAKE payout sync completed: pulled=${pulledCount}, attributed=${attributedCount}, ` +
      `unmatched=${unmatchedCount}, duplicatesSkipped=${duplicateCount}.`;
    return this.result(
      'completed',
      attributedCount,
      0,
      window,
      message,
      context,
      { pulledCount, unmatchedCount, duplicateCount, pageCount },
    );
  }

  private result(
    status: 'completed' | 'failed',
    successCount: number,
    failedCount: number,
    window: ReturnType<typeof getCakeGmt8SettlementMonthWindow>,
    message: string,
    context: SyncAdapterContext,
    counts: { pulledCount: number; unmatchedCount: number; duplicateCount: number; pageCount: number },
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
        pulledCount: counts.pulledCount,
        attributedCount: successCount,
        unmatchedCount: counts.unmatchedCount,
        duplicateCount: counts.duplicateCount,
        pageCount: counts.pageCount,
        failedCount,
        payoutCurrency: 'USD',
        payoutField: 'price',
        payableDispositionPolicy: ['approved'],
        dispositionPolicySource: 'conservative_pending_live_calibration',
        settlementMonth: context.settlementMonth.toISOString().slice(0, 10),
        cakeRequest: {
          startDate: window.startDate,
          endDate: window.endDate,
          endDateMayBeInclusive: true,
          startInclusiveUtc: window.startInclusiveUtc.toISOString(),
          endExclusiveUtc: window.endExclusiveUtc.toISOString(),
          timezone: 'Asia/Shanghai',
          affiliateIdSource: 'affiliate_accounts.account_code',
        },
      },
    };
  }

  private async upsertIncomeRecord(
    record: NormalizedCakeRecord,
    context: SyncAdapterContext,
    window: ReturnType<typeof getCakeGmt8SettlementMonthWindow>,
  ): Promise<boolean> {
    if (!record.externalRecordId) {
      await this.recordUnmatchedIncome(record, context, 'EXTERNAL_ID_MISSING', 'CAKE conversion is missing conversion_id.');
      return false;
    }
    if (!record.payoutField) {
      await this.recordUnmatchedIncome(record, context, 'PAYOUT_MISSING', 'CAKE conversion has no supported payout field.');
      return false;
    }
    if (!record.payoutValid) {
      await this.recordUnmatchedIncome(record, context, 'PAYOUT_INVALID', 'CAKE conversion price is not a valid payout amount.');
      return false;
    }
    if (record.currency !== 'USD') {
      await this.recordUnmatchedIncome(record, context, 'INVALID_CURRENCY', 'CAKE conversion currency is not USD.');
      return false;
    }
    if (!record.occurredAt) {
      const reason = record.timestampHasExplicitTimezone ? 'TIMESTAMP_INVALID' : 'TIMESTAMP_TIMEZONE_UNCONFIRMED';
      await this.recordUnmatchedIncome(
        record,
        context,
        reason,
        'CAKE conversion_date must be a valid timestamp with an explicit timezone.',
      );
      return false;
    }
    if (record.occurredAt < window.startInclusiveUtc || record.occurredAt >= window.endExclusiveUtc) {
      await this.recordUnmatchedIncome(
        record,
        context,
        'OUTSIDE_SETTLEMENT_WINDOW',
        'CAKE conversion is outside the GMT+8 half-open settlement window.',
      );
      return false;
    }
    if (!record.disposition) {
      await this.recordUnmatchedIncome(record, context, 'DISPOSITION_MISSING', 'CAKE conversion disposition is missing.');
      return false;
    }
    const normalizedDisposition = record.disposition.toLowerCase();
    if (NON_FINAL_DISPOSITIONS.has(normalizedDisposition)) {
      await this.recordUnmatchedIncome(record, context, 'PAYOUT_NOT_FINAL', 'CAKE conversion disposition is not final payable.');
      return false;
    }
    if (!PAYABLE_DISPOSITIONS.has(normalizedDisposition)) {
      await this.recordUnmatchedIncome(
        record,
        context,
        'DISPOSITION_UNCONFIRMED',
        'CAKE conversion disposition is not in the conservative payable allowlist.',
      );
      return false;
    }
    if (record.subCandidates.length === 0) {
      await this.recordUnmatchedIncome(record, context, 'SUB_ID_MISSING', 'CAKE conversion has no SUB candidate.');
      return false;
    }

    const mappingResult = await this.findMapping(context, record.subCandidates);
    if (mappingResult.kind === 'none') {
      await this.recordUnmatchedIncome(record, context, 'SUB_ID_NOT_MAPPED', 'CAKE conversion SUB is not mapped to an employee.');
      return false;
    }
    if (mappingResult.kind === 'conflict') {
      await this.recordUnmatchedIncome(
        record,
        context,
        'SUB_ID_EMPLOYEE_CONFLICT',
        'CAKE conversion SUB fields map to different employees.',
      );
      return false;
    }

    const syncedAt = new Date().toISOString();
    const safeRawData = buildCakeStoredData(record, context, syncedAt);
    await this.db().incomeRecord.upsert({
      where: { source_externalRecordId: { source: CAKE_SOURCE, externalRecordId: record.externalRecordId } },
      update: {
        affiliateAccountId: context.affiliateAccountId,
        employeeId: mappingResult.mapping.employeeId,
        settlementMonth: context.settlementMonth,
        subField: mappingResult.mapping.subField,
        subValue: mappingResult.mapping.subValue,
        incomeUsd: record.payoutUsd,
        rawData: safeRawData,
        status: CommonStatus.confirmed,
        importedBy: context.requestedBy,
      },
      create: {
        source: CAKE_SOURCE,
        externalRecordId: record.externalRecordId,
        affiliateAccountId: context.affiliateAccountId,
        employeeId: mappingResult.mapping.employeeId,
        settlementMonth: context.settlementMonth,
        subField: mappingResult.mapping.subField,
        subValue: mappingResult.mapping.subValue,
        incomeUsd: record.payoutUsd,
        rawData: safeRawData,
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
      amountUsd: record.currency === 'USD' && record.payoutField && record.payoutValid ? record.payoutUsd : null,
      currency: record.currency,
      occurredAt: record.occurredAt,
      rawSafeData: buildCakeRawSafeData(record),
    });
  }

  private async findMapping(
    context: SyncAdapterContext,
    candidates: Array<{ subField: string; subValue: string }>,
  ): Promise<
    | { kind: 'none' }
    | { kind: 'conflict' }
    | { kind: 'one'; mapping: CakeMapping }
  > {
    const mappings = await this.db().subIdMapping.findMany({
      where: {
        affiliateAccountId: context.affiliateAccountId,
        effectiveMonth: context.settlementMonth,
        status: CommonStatus.active,
        OR: candidates.map((candidate) => ({ subField: candidate.subField, subValue: candidate.subValue })),
      },
      select: { subField: true, subValue: true, employeeId: true },
    });
    if (mappings.length === 0) return { kind: 'none' };
    const employeeIds = new Set(mappings.map((mapping) => mapping.employeeId));
    if (employeeIds.size > 1) return { kind: 'conflict' };
    const selected =
      candidates
        .map((candidate) =>
          mappings.find(
            (mapping) => mapping.subField === candidate.subField && mapping.subValue === candidate.subValue,
          ),
        )
        .find((mapping): mapping is CakeMapping => Boolean(mapping)) ?? mappings[0];
    return { kind: 'one', mapping: selected };
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
    if (!context.affiliateAccountCode?.trim()) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE affiliate_id must come from affiliateAccount.accountCode.');
    }
  }

  private db(): CakeAdapterPrisma {
    return this.prisma as unknown as CakeAdapterPrisma;
  }
}

export function getCakeGmt8SettlementMonthWindow(settlementMonth: Date) {
  const startInclusiveUtc = new Date(
    Date.UTC(settlementMonth.getUTCFullYear(), settlementMonth.getUTCMonth(), 1, -8, 0, 0, 0),
  );
  const endExclusiveUtc = new Date(
    Date.UTC(settlementMonth.getUTCFullYear(), settlementMonth.getUTCMonth() + 1, 1, -8, 0, 0, 0),
  );
  const endInclusiveDate = new Date(
    Date.UTC(settlementMonth.getUTCFullYear(), settlementMonth.getUTCMonth() + 1, 0),
  );
  return {
    startInclusiveUtc,
    endExclusiveUtc,
    startDate: formatDate(settlementMonth),
    endDate: formatDate(endInclusiveDate),
  };
}

export function normalizeCakeRecord(raw: CakeConversionRecord): NormalizedCakeRecord {
  const externalRecordId = firstNonBlank(
    raw.conversion_id,
    raw.conversionId,
    raw.ConversionID,
    raw.transaction_id,
    raw.transactionId,
    raw.id,
  );
  const rawCurrency = firstNonBlank(raw.currency, raw.currency_code, raw.currencyCode, raw.Currency);
  const payout = firstNamedValue(raw, ['price', 'Price']);
  const payoutUsd = parseDecimal(payout.value);
  const rawTimestamp = firstValue(
    raw.conversion_date,
    raw.conversionDate,
    raw.conversion_time,
    raw.conversionTime,
    raw.created_at,
    raw.createdAt,
  );
  const timestampText = typeof rawTimestamp === 'string' ? rawTimestamp.trim() : '';
  const timestampHasExplicitTimezone =
    rawTimestamp instanceof Date || /(?:Z|[+-]\d{2}:\d{2})$/i.test(timestampText);
  const occurredAt = timestampHasExplicitTimezone ? parseDate(rawTimestamp) : null;

  return {
    externalRecordId,
    payoutUsd: payoutUsd ?? new Prisma.Decimal(0),
    payoutField: payout.key,
    payoutValid: payoutUsd !== null,
    currency: (rawCurrency ?? 'USD').toUpperCase(),
    occurredAt,
    timestampHasExplicitTimezone,
    disposition: firstNonBlank(raw.disposition, raw.Disposition, raw.status, raw.Status),
    subCandidates: normalizeCakeSubCandidates(raw),
    rawData: raw,
  };
}

export function normalizeCakeSubCandidates(raw: CakeConversionRecord) {
  const candidates: Array<{ subField: string; subValue: string }> = [];
  for (let index = 1; index <= 5; index += 1) {
    const canonicalField = `sub${index}`;
    const official = firstNonBlank(raw[`subid_${index}`], raw[`Subid_${index}`], raw[`SubID_${index}`]);
    if (official) {
      candidates.push({ subField: canonicalField, subValue: official });
      continue;
    }
    const aliases: Array<{ subField: string; value: unknown }> = [
      { subField: canonicalField, value: raw[canonicalField] },
      { subField: canonicalField, value: raw[`Sub${index}`] },
      { subField: canonicalField, value: raw[`sub_${index}`] },
      ...(index === 1
        ? [
            { subField: 'sub_id', value: raw.sub_id },
            { subField: 'sub_id', value: raw.SubId },
            { subField: 'subid', value: raw.subid },
            { subField: 'subid', value: raw.Subid },
          ]
        : []),
    ];
    const alias = aliases
      .map((candidate) => ({ subField: candidate.subField, subValue: asNonBlankString(candidate.value) }))
      .find((candidate): candidate is { subField: string; subValue: string } => Boolean(candidate.subValue));
    if (alias) candidates.push(alias);
  }
  return candidates;
}

function parseCredentialPayload(payload: unknown): CakeCredentialPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
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
  };
}

function firstNamedValue(record: CakeConversionRecord, keys: string[]): { key: string | null; value: unknown } {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return { key, value };
  }
  return { key: null, value: undefined };
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
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseDecimal(value: unknown): Prisma.Decimal | null {
  if (!(typeof value === 'number' || typeof value === 'string') || String(value).trim() === '') return null;
  try {
    return new Prisma.Decimal(value);
  } catch {
    return null;
  }
}

function parseDate(value: unknown): Date | null {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildCakeStoredData(
  record: NormalizedCakeRecord,
  context: SyncAdapterContext,
  syncedAt: string,
): Prisma.InputJsonObject {
  return compactJsonObject({
    conversion_id: record.externalRecordId ?? undefined,
    conversion_date: record.occurredAt?.toISOString(),
    disposition: record.disposition ?? undefined,
    payout_usd: record.payoutUsd.toString(),
    payout_field: record.payoutField ?? undefined,
    currency: record.currency,
    sync_task_id: context.taskId,
    synced_at: syncedAt,
    ...Object.fromEntries(record.subCandidates.map((candidate) => [candidate.subField, candidate.subValue])),
  });
}

function buildCakeRawSafeData(record: NormalizedCakeRecord): Prisma.InputJsonObject {
  return compactJsonObject({
    conversionId: record.externalRecordId ?? undefined,
    disposition: record.disposition ?? undefined,
    currency: record.currency,
    payoutUsd: record.payoutField ? record.payoutUsd.toString() : undefined,
    payoutField: record.payoutField ?? undefined,
    conversionTime: record.occurredAt?.toISOString(),
    ...Object.fromEntries(record.subCandidates.map((candidate) => [candidate.subField, candidate.subValue])),
  });
}

function compactJsonObject(
  value: Record<string, Prisma.InputJsonValue | undefined>,
): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined && child !== null),
  ) as Prisma.InputJsonObject;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sanitizeErrorMessage(message: string, credential: CakeCredentialPayload): string {
  let sanitized = message.replace(/([?&]api_key=)[^&\s]+/gi, '$1[REDACTED]');
  sanitized = sanitized.split(credential.apiKey).join('[REDACTED]');
  return sanitized;
}
