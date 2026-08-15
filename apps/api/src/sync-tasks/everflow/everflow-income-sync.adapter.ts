import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AuditResult,
  CommonStatus,
  Prisma,
  SyncExecutionErrorCategory,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskType,
} from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../../common/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import {
  EffectiveSubIdMappingReader,
  isActiveEffectiveSubIdMapping,
  resolveEffectiveSubIdMappings,
} from '../../sub-id-mappings/effective-sub-id-mappings';
import { SyncUnmatchedEventsService } from '../../sync-unmatched-events/sync-unmatched-events.service';
import { SyncAdapter, SyncAdapterContext, SyncAdapterResult } from '../sync-adapter';
import { providerErrorCategory } from '../provider-request-error';
import {
  EverflowClient,
  EverflowCredentialPayload,
  EverflowSubRevenueRow,
  EverflowTimezone,
} from './everflow-client';

const EVERFLOW_SOURCE = 'everflow';
const SUB_FIELD = 'sub1';
export const EVERFLOW_MONTHLY_SUB_CALIBRATION_ACTION = 'everflow.monthly_sub_revenue.calibration.pass';
export const EVERFLOW_MONTHLY_SUB_CALIBRATION_READ_ACTION = 'everflow.monthly_sub_revenue.calibration.read';

type EverflowAdapterPrisma = EffectiveSubIdMappingReader & {
  affiliateAccountCredential: { findUnique(args: unknown): Promise<{ updatedAt: Date } | null> };
  auditLog: { findFirst(args: unknown): Promise<{ id: string; action: string; createdAt: Date } | null> };
  incomeRecord: {
    upsert(args: unknown): Promise<unknown>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
};

type MonthlyRow = {
  subValue: string | null;
  revenueUsd: Prisma.Decimal;
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

    if (!(await this.hasCurrentCalibration(context.affiliateAccountId as string))) {
      const message = 'Everflow monthly SUB revenue sync is blocked until current credentials pass read-only calibration.';
      return this.result('failed', 0, 1, window, message, context, {
        pulledCount: 0,
        positiveRevenueCount: 0,
        attributedCount: 0,
        unmatchedCount: 0,
        zeroRevenueCount: 0,
        calibrationRequired: true,
      }, SyncExecutionErrorCategory.BUSINESS_REJECTED);
    }

    try {
      const timezones = await this.client.getTimezones(credential);
      const timezone = resolveEverflowGmt8Timezone(timezones.timezones ?? []);
      if (!timezone) {
        return this.result('failed', 0, 1, window, 'Everflow metadata did not provide an unambiguous GMT+8 timezone; no income was written.', context, {
          pulledCount: 0,
          positiveRevenueCount: 0,
          attributedCount: 0,
          unmatchedCount: 0,
          zeroRevenueCount: 0,
          timezoneConfirmed: false,
        }, SyncExecutionErrorCategory.BUSINESS_REJECTED);
      }
      const response = await this.client.getAffiliateSubRevenueSummary({
        credential,
        from: window.from,
        to: window.to,
        timezoneId: timezone.timezoneId,
        subField: SUB_FIELD,
      });
      if (response.incomplete_results === true) {
        return this.result('failed', 0, 1, window, 'Everflow returned incomplete aggregate results; no income was written.', context, {
          pulledCount: response.table?.length ?? 0,
          positiveRevenueCount: 0,
          attributedCount: 0,
          unmatchedCount: 0,
          zeroRevenueCount: 0,
          incompleteResults: true,
          timezoneId: timezone.timezoneId,
        }, SyncExecutionErrorCategory.BUSINESS_REJECTED);
      }

      const rows = aggregateRows(response.table ?? []);
      let positiveRevenueCount = 0;
      let attributedCount = 0;
      let unmatchedCount = 0;
      let zeroRevenueCount = 0;

      for (const row of rows) {
        const externalRecordId = monthlyExternalRecordId(EVERFLOW_SOURCE, context, row.subValue);
        if (row.revenueUsd.isZero()) {
          zeroRevenueCount += 1;
          await this.db().incomeRecord.deleteMany({
            where: { source: EVERFLOW_SOURCE, externalRecordId },
          });
          continue;
        }
        positiveRevenueCount += 1;
        if (!row.subValue) {
          unmatchedCount += 1;
          await this.db().incomeRecord.deleteMany({ where: { source: EVERFLOW_SOURCE, externalRecordId } });
          await this.recordUnmatched(row, externalRecordId, context, 'SUB_ID_MISSING', 'Everflow monthly revenue row has no SUB1 value.');
          continue;
        }
        const mappings = await resolveEffectiveSubIdMappings(this.db(), {
          affiliateAccountId: context.affiliateAccountId,
          subField: SUB_FIELD,
          subValue: row.subValue,
          settlementMonth: context.settlementMonth,
        });
        const activeMappings = mappings.filter(isActiveEffectiveSubIdMapping);
        const employeeIds = [...new Set(activeMappings.map((mapping) => mapping.employeeId))];
        if (mappings.length === 0 || activeMappings.length !== mappings.length) {
          unmatchedCount += 1;
          await this.db().incomeRecord.deleteMany({ where: { source: EVERFLOW_SOURCE, externalRecordId } });
          await this.recordUnmatched(row, externalRecordId, context, 'SUB_ID_NOT_MAPPED', 'Everflow SUB1 is not mapped to an employee.');
          continue;
        }
        if (employeeIds.length !== 1) {
          unmatchedCount += 1;
          await this.db().incomeRecord.deleteMany({ where: { source: EVERFLOW_SOURCE, externalRecordId } });
          await this.recordUnmatched(row, externalRecordId, context, 'SUB_ID_EMPLOYEE_CONFLICT', 'Everflow SUB1 maps to multiple employees.');
          continue;
        }
        if (activeMappings.some((mapping) => mapping.employee.status !== CommonStatus.active)) {
          unmatchedCount += 1;
          await this.db().incomeRecord.deleteMany({ where: { source: EVERFLOW_SOURCE, externalRecordId } });
          await this.recordUnmatched(row, externalRecordId, context, 'EMPLOYEE_DISABLED', 'Everflow SUB1 maps to a disabled employee.');
          continue;
        }

        await this.db().incomeRecord.upsert({
          where: { source_externalRecordId: { source: EVERFLOW_SOURCE, externalRecordId } },
          create: {
            settlementMonth: context.settlementMonth,
            affiliateAccountId: context.affiliateAccountId,
            employeeId: employeeIds[0],
            source: EVERFLOW_SOURCE,
            externalRecordId,
            subField: SUB_FIELD,
            subValue: row.subValue,
            incomeUsd: row.revenueUsd,
            rawData: safeRawData(row, context),
            status: CommonStatus.confirmed,
            importedBy: context.requestedBy ?? null,
          },
          update: {
            settlementMonth: context.settlementMonth,
            affiliateAccountId: context.affiliateAccountId,
            employeeId: employeeIds[0],
            subField: SUB_FIELD,
            subValue: row.subValue,
            incomeUsd: row.revenueUsd,
            rawData: safeRawData(row, context),
            status: CommonStatus.confirmed,
            importedBy: context.requestedBy ?? null,
          },
        });
        attributedCount += 1;
      }

      const message = `Everflow monthly SUB revenue sync completed: pulled=${response.table?.length ?? 0}, positive=${positiveRevenueCount}, attributed=${attributedCount}, unmatched=${unmatchedCount}, zero=${zeroRevenueCount}.`;
      return this.result('completed', attributedCount, unmatchedCount, window, message, context, {
        pulledCount: response.table?.length ?? 0,
        aggregateRowCount: rows.length,
        positiveRevenueCount,
        attributedCount,
        unmatchedCount,
        zeroRevenueCount,
        incompleteResults: false,
        timezoneId: timezone.timezoneId,
        timezoneName: timezone.name,
        timezoneUtcOffset: timezone.utcOffset,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Everflow aggregate reporting request failed.';
      return this.result('failed', 0, 1, window, message, context, {
        pulledCount: 0,
        positiveRevenueCount: 0,
        attributedCount: 0,
        unmatchedCount: 0,
        zeroRevenueCount: 0,
      }, providerErrorCategory(error));
    }
  }

  private async hasCurrentCalibration(affiliateAccountId: string) {
    const credential = await this.db().affiliateAccountCredential.findUnique({
      where: { affiliateAccountId },
      select: { updatedAt: true },
    });
    if (!credential) return false;
    const calibration = await this.db().auditLog.findFirst({
      where: {
        action: { in: [EVERFLOW_MONTHLY_SUB_CALIBRATION_ACTION, EVERFLOW_MONTHLY_SUB_CALIBRATION_READ_ACTION] },
        objectType: 'affiliate_accounts',
        objectId: affiliateAccountId,
        result: AuditResult.success,
        createdAt: { gte: credential.updatedAt },
      },
      select: { id: true, action: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return calibration?.action === EVERFLOW_MONTHLY_SUB_CALIBRATION_ACTION;
  }

  private async recordUnmatched(
    row: MonthlyRow,
    externalRecordId: string,
    context: SyncAdapterContext,
    reasonCode: string,
    reasonMessage: string,
  ) {
    await this.unmatchedEvents.recordUnmatchedEvent({
      settlementMonth: context.settlementMonth,
      sourceType: SyncTaskSourceType.affiliate_income,
      taskType: SyncTaskType.affiliate_income,
      platform: SyncTaskPlatform.everflow,
      affiliateAccountId: context.affiliateAccountId,
      syncTaskId: context.taskId,
      thirdPartyEventId: externalRecordId,
      reasonCode,
      reasonMessage,
      subField: SUB_FIELD,
      subValue: row.subValue,
      amountUsd: row.revenueUsd,
      rawSafeData: { subField: SUB_FIELD, subValue: row.subValue, amount: row.revenueUsd.toString(), currency: 'USD' },
    });
  }

  private result(
    status: 'completed' | 'failed',
    successCount: number,
    failedCount: number,
    window: ReturnType<typeof getGmt8SettlementMonthWindow>,
    message: string,
    context: SyncAdapterContext,
    statistics: Record<string, unknown>,
    errorCategory?: SyncExecutionErrorCategory,
  ): SyncAdapterResult {
    return {
      status,
      successCount,
      failedCount,
      message,
      errorMessage: status === 'failed' ? message : null,
      errorCategory,
      resultPayload: {
        adapterKey: this.adapterKey,
        source: EVERFLOW_SOURCE,
        sourceReport: 'affiliate.reporting.entity.table',
        aggregation: 'monthly_revenue_by_sub1',
        currency: 'USD',
        settlementMonth: context.settlementMonth.toISOString().slice(0, 10),
        request: { from: window.from, to: window.to, timezoneId: statistics.timezoneId ?? null, subField: SUB_FIELD },
        ...statistics,
        rawPayloadReturned: false,
      },
    };
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
  const year = settlementMonth.getUTCFullYear();
  const month = settlementMonth.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return {
    startInclusiveUtc: new Date(Date.UTC(year, month, 1, -8)),
    endExclusiveUtc: new Date(Date.UTC(year, month + 1, 1, -8)),
    from: formatDate(year, month + 1, 1),
    to: formatDate(year, month + 1, lastDay),
  };
}

export function resolveEverflowGmt8Timezone(timezones: EverflowTimezone[]) {
  const candidates = timezones.flatMap((timezone) => {
    const timezoneId = Number(timezone.timezone_id);
    const name = [timezone.timezone_name, timezone.timezone].filter(Boolean).join(' / ').trim();
    const utcOffset = String(timezone.utc_offset ?? '').trim();
    const offsetMinutes = parseUtcOffsetMinutes(utcOffset);
    const ianaGmt8 = isStableGmt8Iana(timezone.timezone);
    const gmt8Confirmed = offsetMinutes === 480 || (offsetMinutes === null && ianaGmt8);
    return Number.isInteger(timezoneId) && gmt8Confirmed
      ? [{ timezoneId, name: name || `timezone:${timezoneId}`, utcOffset }]
      : [];
  });
  return candidates.sort((left, right) => timezonePriority(left.name) - timezonePriority(right.name) || left.timezoneId - right.timezoneId)[0] ?? null;
}

function timezonePriority(name: string) {
  if (/asia\/shanghai/i.test(name)) return 0;
  if (/china standard time/i.test(name)) return 1;
  if (/china|beijing|chongqing/i.test(name)) return 2;
  if (/hong kong/i.test(name)) return 3;
  return 4;
}

function parseUtcOffsetMinutes(value: string): number | null {
  const normalized = value.replace(/\s/g, '').toUpperCase().replace(/^UTC|^GMT/, '');
  if (!normalized) return null;
  const clock = normalized.match(/^([+-]?)(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (clock) {
    const sign = clock[1] === '-' ? -1 : 1;
    return sign * (Number(clock[2]) * 60 + Number(clock[3]));
  }
  const compactClock = normalized.match(/^([+-]?)(0\d)(\d{2})$/);
  if (compactClock) {
    const sign = compactClock[1] === '-' ? -1 : 1;
    return sign * (Number(compactClock[2]) * 60 + Number(compactClock[3]));
  }
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) return null;
  if (Math.abs(numeric) <= 24) return numeric * 60;
  if (Math.abs(numeric) <= 24 * 60) return numeric;
  if (Math.abs(numeric) <= 24 * 60 * 60) return numeric / 60;
  return null;
}

function isStableGmt8Iana(value: string | undefined) {
  if (!value) return false;
  try {
    return ['2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z'].every((iso) => {
      const part = new Intl.DateTimeFormat('en', { timeZone: value, timeZoneName: 'longOffset' })
        .formatToParts(new Date(iso))
        .find((item) => item.type === 'timeZoneName')?.value;
      return part === 'GMT+08:00';
    });
  } catch {
    return false;
  }
}

export function normalizeEverflowSummaryRow(row: EverflowSubRevenueRow): MonthlyRow {
  const columns = row.columns ?? [];
  const column = columns.find((item) => item.column_type?.toLowerCase() === SUB_FIELD) ?? columns[0];
  const subValue = asNonBlank(column?.id) ?? asNonBlank(column?.label);
  const rawRevenue = row.reporting?.revenue;
  if (!(['string', 'number'].includes(typeof rawRevenue)) || String(rawRevenue).trim() === '') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Everflow aggregate row is missing reporting.revenue.');
  }
  try {
    const revenueUsd = new Prisma.Decimal(rawRevenue as string | number);
    if (!revenueUsd.isFinite()) throw new Error('not finite');
    return { subValue, revenueUsd };
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Everflow aggregate row has invalid reporting.revenue.');
  }
}

function aggregateRows(rows: EverflowSubRevenueRow[]): MonthlyRow[] {
  const totals = new Map<string, MonthlyRow>();
  for (const raw of rows) {
    const row = normalizeEverflowSummaryRow(raw);
    const key = row.subValue ?? '';
    const current = totals.get(key);
    totals.set(key, current ? { ...row, revenueUsd: current.revenueUsd.plus(row.revenueUsd) } : row);
  }
  return [...totals.values()];
}

function monthlyExternalRecordId(source: string, context: SyncAdapterContext, subValue: string | null) {
  const month = context.settlementMonth.toISOString().slice(0, 7);
  const digest = createHash('sha256').update(subValue ?? '(blank)').digest('hex').slice(0, 24);
  return `${source}:sub-month:${context.affiliateAccountId}:${month}:${digest}`;
}

function safeRawData(row: MonthlyRow, context: SyncAdapterContext): Prisma.InputJsonObject {
  return {
    report: 'monthly_revenue_by_sub1',
    settlementMonth: context.settlementMonth.toISOString().slice(0, 7),
    subField: SUB_FIELD,
    subValue: row.subValue,
    revenueUsd: row.revenueUsd.toString(),
    timezone: 'Asia/Shanghai',
  } as Prisma.InputJsonObject;
}

function parseCredentialPayload(payload: unknown): EverflowCredentialPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Everflow credential payload is required.');
  }
  const record = payload as Record<string, unknown>;
  const apiKey = asNonBlank(record.apiKey);
  if (!apiKey) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Everflow credential apiKey is required.');
  return { apiKey, baseUrl: asNonBlank(record.baseUrl) ?? undefined };
}

function asNonBlank(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatDate(year: number, month: number, day: number) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
