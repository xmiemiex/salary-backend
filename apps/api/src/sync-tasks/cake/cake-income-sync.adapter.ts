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
import { AuditService } from '../../audit/audit.service';
import {
  CAKE_ADJUSTMENT_SOURCE,
  cakeAdjustmentExternalRecordId,
  readCakeAdjustmentMetadata,
} from '../../cake-income-adjustments/cake-income-adjustment.utils';
import { AppError } from '../../common/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncUnmatchedEventsService } from '../../sync-unmatched-events/sync-unmatched-events.service';
import { SyncAdapter, SyncAdapterContext, SyncAdapterResult } from '../sync-adapter';
import { providerErrorCategory } from '../provider-request-error';
import { CakeClient, CakeCredentialPayload, CakeSubAffiliateSummaryRecord } from './cake-client';

const CAKE_SOURCE = 'cake';
const SUB_FIELD = 'sub1';
export const CAKE_MONTHLY_SUB_CALIBRATION_ACTION = 'cake.monthly_sub_revenue.default_timezone.calibration.pass';
export const CAKE_MONTHLY_SUB_CALIBRATION_READ_ACTION = 'cake.monthly_sub_revenue.calibration.read';

type CakeSummaryRow = { subValue: string | null; revenueUsd: Prisma.Decimal };
type Mapping = { employeeId: string };
type CakeAdapterPrisma = {
  affiliateAccountCredential: { findUnique(args: unknown): Promise<{ updatedAt: Date } | null> };
  auditLog: { findFirst(args: unknown): Promise<{ id: string; action: string; createdAt: Date } | null> };
  subIdMapping: { findMany(args: unknown): Promise<Mapping[]> };
  incomeRecord: {
    upsert(args: unknown): Promise<unknown>;
    deleteMany(args: unknown): Promise<{ count: number }>;
    findUnique(args: unknown): Promise<{
      id: string;
      status: CommonStatus;
      incomeUsd: Prisma.Decimal;
      rawData: Prisma.JsonValue;
    } | null>;
    update(args: unknown): Promise<unknown>;
  };
};

@Injectable()
export class CakeIncomeSyncAdapter implements SyncAdapter {
  readonly adapterKey = 'affiliate_income.cake';

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: CakeClient,
    private readonly unmatchedEvents: SyncUnmatchedEventsService,
    private readonly audit: AuditService,
  ) {}

  async execute(context: SyncAdapterContext): Promise<SyncAdapterResult> {
    this.assertContext(context);
    const credential = parseCredentialPayload(context.credential.payload);
    const affiliateId = context.affiliateAccountCode as string;
    const window = getCakeProviderDefaultSettlementMonthWindow(context.settlementMonth);

    if (!(await this.hasCurrentCalibration(context.affiliateAccountId as string))) {
      const message = 'CAKE monthly SubAffiliate revenue sync is blocked until current credentials pass read-only calibration.';
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
      const response = await this.client.getSubAffiliateSummary({
        credential,
        affiliateId,
        startDate: window.startDate,
        endDate: window.endDate,
      });
      if (response.rowCount !== null && response.rowCount > response.rows.length) {
        return this.result('failed', 0, 1, window, 'CAKE returned an incomplete SubAffiliateSummary; no income was written.', context, {
          pulledCount: response.rows.length,
          providerRowCount: response.rowCount,
          positiveRevenueCount: 0,
          attributedCount: 0,
          unmatchedCount: 0,
          zeroRevenueCount: 0,
          incompleteResults: true,
        }, SyncExecutionErrorCategory.BUSINESS_REJECTED);
      }

      const rows = aggregateRows(response.rows);
      let positiveRevenueCount = 0;
      let attributedCount = 0;
      let unmatchedCount = 0;
      let zeroRevenueCount = 0;

      await this.prisma.$transaction(async (transaction) => {
        const db = transaction as unknown as CakeAdapterPrisma;
        for (const row of rows) {
          const externalRecordId = monthlyExternalRecordId(context, row.subValue);
          if (row.revenueUsd.isZero()) {
            zeroRevenueCount += 1;
            await db.incomeRecord.deleteMany({ where: { source: CAKE_SOURCE, externalRecordId } });
            await this.markAdjustmentStaleWhenBaseChanges(context, row, true, db, transaction);
            continue;
          }
          positiveRevenueCount += 1;
          if (!row.subValue) {
            unmatchedCount += 1;
            await db.incomeRecord.deleteMany({ where: { source: CAKE_SOURCE, externalRecordId } });
            await this.recordUnmatched(row, externalRecordId, context, 'SUB_ID_MISSING', 'CAKE SubAffiliateSummary revenue row has no SUB1 value.', transaction);
            continue;
          }
          const mappings = await db.subIdMapping.findMany({
            where: {
              affiliateAccountId: context.affiliateAccountId,
              subField: SUB_FIELD,
              subValue: row.subValue,
              effectiveMonth: context.settlementMonth,
              status: CommonStatus.active,
            },
            select: { employeeId: true },
          });
          const employeeIds = [...new Set(mappings.map((mapping) => mapping.employeeId))];
          if (employeeIds.length === 0) {
            unmatchedCount += 1;
            await db.incomeRecord.deleteMany({ where: { source: CAKE_SOURCE, externalRecordId } });
            await this.markAdjustmentStaleWhenBaseChanges(context, row, true, db, transaction);
            await this.recordUnmatched(row, externalRecordId, context, 'SUB_ID_NOT_MAPPED', 'CAKE SUB1 is not mapped to an employee.', transaction);
            continue;
          }
          if (employeeIds.length !== 1) {
            unmatchedCount += 1;
            await db.incomeRecord.deleteMany({ where: { source: CAKE_SOURCE, externalRecordId } });
            await this.markAdjustmentStaleWhenBaseChanges(context, row, true, db, transaction);
            await this.recordUnmatched(row, externalRecordId, context, 'SUB_ID_EMPLOYEE_CONFLICT', 'CAKE SUB1 maps to multiple employees.', transaction);
            continue;
          }

          await db.incomeRecord.upsert({
          where: { source_externalRecordId: { source: CAKE_SOURCE, externalRecordId } },
          create: {
            settlementMonth: context.settlementMonth,
            affiliateAccountId: context.affiliateAccountId,
            employeeId: employeeIds[0],
            source: CAKE_SOURCE,
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
          await this.markAdjustmentStaleWhenBaseChanges(context, row, false, db, transaction);
          attributedCount += 1;
        }
      });

      const message = `CAKE monthly SubAffiliate revenue sync completed: pulled=${response.rows.length}, positive=${positiveRevenueCount}, attributed=${attributedCount}, unmatched=${unmatchedCount}, zero=${zeroRevenueCount}.`;
      return this.result('completed', attributedCount, unmatchedCount, window, message, context, {
        pulledCount: response.rows.length,
        aggregateRowCount: rows.length,
        providerRowCount: response.rowCount,
        positiveRevenueCount,
        attributedCount,
        unmatchedCount,
        zeroRevenueCount,
        incompleteResults: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'CAKE SubAffiliateSummary request failed.';
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
        action: { in: [CAKE_MONTHLY_SUB_CALIBRATION_ACTION, CAKE_MONTHLY_SUB_CALIBRATION_READ_ACTION] },
        objectType: 'affiliate_accounts',
        objectId: affiliateAccountId,
        result: AuditResult.success,
        createdAt: { gte: credential.updatedAt },
      },
      select: { id: true, action: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return calibration?.action === CAKE_MONTHLY_SUB_CALIBRATION_ACTION;
  }

  private async recordUnmatched(
    row: CakeSummaryRow,
    externalRecordId: string,
    context: SyncAdapterContext,
    reasonCode: string,
    reasonMessage: string,
    transaction?: Prisma.TransactionClient,
  ) {
    await this.unmatchedEvents.recordUnmatchedEvent({
      settlementMonth: context.settlementMonth,
      sourceType: SyncTaskSourceType.affiliate_income,
      taskType: SyncTaskType.affiliate_income,
      platform: SyncTaskPlatform.cake,
      affiliateAccountId: context.affiliateAccountId,
      syncTaskId: context.taskId,
      thirdPartyEventId: externalRecordId,
      reasonCode,
      reasonMessage,
      subField: SUB_FIELD,
      subValue: row.subValue,
      amountUsd: row.revenueUsd,
      rawSafeData: { subField: SUB_FIELD, subValue: row.subValue, amount: row.revenueUsd.toString(), currency: 'USD' },
    }, transaction);
  }

  private async markAdjustmentStaleWhenBaseChanges(
    context: SyncAdapterContext,
    row: CakeSummaryRow,
    baseUnavailable = false,
    db: CakeAdapterPrisma = this.db(),
    transaction?: Prisma.TransactionClient,
  ) {
    if (!row.subValue) return;
    const externalRecordId = cakeAdjustmentExternalRecordId(
      context.affiliateAccountId as string,
      context.settlementMonth,
      row.subValue,
    );
    const adjustment = await db.incomeRecord.findUnique({
      where: { source_externalRecordId: { source: CAKE_ADJUSTMENT_SOURCE, externalRecordId } },
    });
    if (!adjustment || adjustment.status === CommonStatus.disabled) return;
    const metadata = readCakeAdjustmentMetadata(adjustment.rawData);
    if (!metadata) return;
    const previousBase = new Prisma.Decimal(metadata.baseRevenueUsd);
    if (!baseUnavailable && previousBase.equals(row.revenueUsd)) return;

    const targetRevenue = new Prisma.Decimal(metadata.targetRevenueUsd);
    const recalculatedAdjustment = targetRevenue.minus(row.revenueUsd);
    const staleMetadata = {
      ...metadata,
      baseRevenueUsd: row.revenueUsd.toString(),
      adjustmentUsd: recalculatedAdjustment.toString(),
      beforeRevenueUsd: row.revenueUsd.toString(),
      afterRevenueUsd: targetRevenue.toString(),
      stale: true,
      staleReason: baseUnavailable ? 'cake_base_unavailable' as const : 'cake_base_revenue_changed' as const,
      previousBaseRevenueUsd: previousBase.toString(),
      currentBaseRevenueUsd: row.revenueUsd.toString(),
    };
    const after = await db.incomeRecord.update({
      where: { id: adjustment.id },
      data: {
        incomeUsd: recalculatedAdjustment,
        rawData: staleMetadata as unknown as Prisma.InputJsonObject,
        status: CommonStatus.draft,
        importedBy: context.requestedBy ?? null,
      },
    });
    await this.audit.success({
      actorUserId: context.requestedBy ?? undefined,
      action: baseUnavailable
        ? 'cake_income_adjustment.base_unavailable_stale'
        : 'cake_income_adjustment.base_changed_stale',
      objectType: 'income_records',
      objectId: adjustment.id,
      settlementMonth: context.settlementMonth,
      beforeData: {
        status: adjustment.status,
        baseRevenueUsd: previousBase.toString(),
        adjustmentUsd: adjustment.incomeUsd.toString(),
      },
      afterData: {
        status: CommonStatus.draft,
        baseRevenueUsd: row.revenueUsd.toString(),
        adjustmentUsd: recalculatedAdjustment.toString(),
        stale: true,
      },
      changedFields: ['incomeUsd', 'rawData', 'status'],
      requestPayload: {
        syncTaskId: context.taskId,
        affiliateAccountId: context.affiliateAccountId,
        settlementMonth: context.settlementMonth.toISOString().slice(0, 7),
        subField: SUB_FIELD,
        subValue: row.subValue,
      },
    }, transaction);
    return after;
  }

  private result(
    status: 'completed' | 'failed',
    successCount: number,
    failedCount: number,
    window: ReturnType<typeof getCakeProviderDefaultSettlementMonthWindow>,
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
        source: CAKE_SOURCE,
        sourceReport: 'Reports/SubAffiliateSummary',
        aggregation: 'monthly_revenue_by_sub1',
        affiliateIdSource: 'affiliate_accounts.account_code',
        currency: 'USD',
        settlementMonth: context.settlementMonth.toISOString().slice(0, 10),
        cakeRequest: {
          affiliateId: context.affiliateAccountCode,
          startDate: window.startDate,
          endDate: window.endDate,
          providerTimezone: 'cake_system_default',
          requestedSettlementTimezone: 'Asia/Shanghai',
          explicitTimezoneSupported: false,
          manualCstAdjustmentRequired: true,
          boundary: '[start,end)',
        },
        ...statistics,
        rawPayloadReturned: false,
      },
    };
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

export function getCakeProviderDefaultSettlementMonthWindow(settlementMonth: Date) {
  const year = settlementMonth.getUTCFullYear();
  const month = settlementMonth.getUTCMonth();
  return {
    startDate: `${formatDate(year, month + 1, 1)}T00:00:00`,
    endDate: `${formatDate(year, month + 2, 1)}T00:00:00`,
    providerTimezone: 'cake_system_default' as const,
    requestedSettlementTimezone: 'Asia/Shanghai' as const,
  };
}

export function normalizeCakeSummaryRow(raw: CakeSubAffiliateSummaryRecord): CakeSummaryRow {
  const subValue = firstNonBlank(raw.sub_id, raw.SubId, raw.subid, raw.SubID);
  const rawRevenue = raw.revenue ?? raw.Revenue;
  if (!(['string', 'number'].includes(typeof rawRevenue)) || String(rawRevenue).trim() === '') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE SubAffiliateSummary row is missing revenue.');
  }
  try {
    const revenueUsd = new Prisma.Decimal(rawRevenue as string | number);
    if (!revenueUsd.isFinite()) throw new Error('not finite');
    return { subValue, revenueUsd };
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE SubAffiliateSummary row has invalid revenue.');
  }
}

function aggregateRows(rawRows: CakeSubAffiliateSummaryRecord[]) {
  const totals = new Map<string, CakeSummaryRow>();
  for (const raw of rawRows) {
    const row = normalizeCakeSummaryRow(raw);
    const key = row.subValue ?? '';
    const current = totals.get(key);
    totals.set(key, current ? { ...row, revenueUsd: current.revenueUsd.plus(row.revenueUsd) } : row);
  }
  return [...totals.values()];
}

function monthlyExternalRecordId(context: SyncAdapterContext, subValue: string | null) {
  const month = context.settlementMonth.toISOString().slice(0, 7);
  const digest = createHash('sha256').update(subValue ?? '(blank)').digest('hex').slice(0, 24);
  return `${CAKE_SOURCE}:sub-month:${context.affiliateAccountId}:${month}:${digest}`;
}

function safeRawData(row: CakeSummaryRow, context: SyncAdapterContext): Prisma.InputJsonObject {
  return {
    report: 'monthly_revenue_by_sub1',
    settlementMonth: context.settlementMonth.toISOString().slice(0, 7),
    subField: SUB_FIELD,
    subValue: row.subValue,
    revenueUsd: row.revenueUsd.toString(),
    providerTimezone: 'cake_system_default',
    requestedSettlementTimezone: 'Asia/Shanghai',
    explicitTimezoneSupported: false,
    manualCstAdjustmentRequired: true,
  } as Prisma.InputJsonObject;
}

function parseCredentialPayload(payload: unknown): CakeCredentialPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE credential payload is required.');
  }
  const record = payload as Record<string, unknown>;
  const apiKey = firstNonBlank(record.apiKey);
  const baseUrl = firstNonBlank(record.baseUrl);
  if (!apiKey) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE credential apiKey is required.');
  if (!baseUrl) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE credential baseUrl is required.');
  return { apiKey, baseUrl, conversionsPath: firstNonBlank(record.conversionsPath) ?? undefined };
}

function firstNonBlank(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function formatDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
