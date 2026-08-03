import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { CredentialReaderService } from '../../api-credentials/credential-reader.service';
import { AuditService } from '../../audit/audit.service';
import { Actor } from '../../auth/auth.types';
import { AppError } from '../../common/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import { EverflowClient, EverflowCredentialPayload } from './everflow-client';
import {
  EVERFLOW_GMT8_TIMEZONE_ID,
  EVERFLOW_MONTHLY_SUB_CALIBRATION_ACTION,
  getGmt8SettlementMonthWindow,
  normalizeEverflowSummaryRow,
} from './everflow-income-sync.adapter';

export type EverflowCalibrationInput = { settlementMonth?: string; startDate?: string; endDate?: string };

@Injectable()
export class EverflowCalibrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialReaderService,
    private readonly client: EverflowClient,
    private readonly audit: AuditService,
  ) {}

  async run(affiliateAccountId: string, input: EverflowCalibrationInput, actor: Actor) {
    const account = await this.prisma.affiliateAccount.findUnique({
      where: { id: affiliateAccountId },
      select: { id: true, platform: true, accountCode: true, accountName: true },
    });
    if (!account) throw new AppError(ERROR_CODES.NOT_FOUND, 'Affiliate account not found.');
    if (account.platform !== 'everflow') throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Everflow calibration requires an everflow affiliate account.');
    const monthDate = parseMonth(input);
    const window = getGmt8SettlementMonthWindow(monthDate);
    const internal = await this.credentials.getAffiliateAccountCredentialPayload(account.id);
    const credential = parseCredential(internal.payload);
    const [response, mappings] = await Promise.all([
      this.client.getAffiliateSubRevenueSummary({ credential, from: window.from, to: window.to, timezoneId: EVERFLOW_GMT8_TIMEZONE_ID, subField: 'sub1' }),
      this.prisma.subIdMapping.findMany({
        where: { affiliateAccountId: account.id, effectiveMonth: monthDate, status: CommonStatus.active },
        select: { subField: true, subValue: true, employeeId: true },
      }),
    ]);
    const rows = (response.table ?? []).map(normalizeEverflowSummaryRow);
    const rowRevenue = rows.reduce((total, row) => total.plus(row.revenueUsd), new Prisma.Decimal(0));
    const summaryRevenue = decimalOrNull(response.summary?.revenue);
    const totalsEqual = summaryRevenue !== null && summaryRevenue.equals(rowRevenue);
    const complete = response.incomplete_results !== true;
    const attribution = summarizeAttribution(rows, mappings);
    const writeGateEligible = complete && totalsEqual;
    const evidence = {
      readOnly: true,
      rawPayloadReturned: false,
      writeGateEligible,
      affiliateAccountId: account.id,
      accountName: account.accountName,
      accountCode: account.accountCode,
      report: '/v1/affiliates/reporting/entity/table',
      request: { from: window.from, to: window.to, timezoneId: EVERFLOW_GMT8_TIMEZONE_ID, currencyId: 'USD', column: 'sub1' },
      returnedCount: rows.length,
      incompleteResults: response.incomplete_results ?? false,
      revenue: { currency: 'USD', rowTotal: rowRevenue.toString(), summaryTotal: summaryRevenue?.toString() ?? null, totalsEqual },
      rows: rows.map((row) => ({ subField: 'sub1', subValue: row.subValue, revenue: row.revenueUsd.toString() })),
      attribution,
    };
    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: writeGateEligible ? EVERFLOW_MONTHLY_SUB_CALIBRATION_ACTION : 'everflow.monthly_sub_revenue.calibration.read',
      objectType: 'affiliate_accounts',
      objectId: account.id,
      afterData: evidence,
      changedFields: [],
      requestPayload: { settlementMonth: monthDate.toISOString().slice(0, 7) },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return evidence;
  }
}

function parseMonth(input: EverflowCalibrationInput) {
  const month = input.settlementMonth?.slice(0, 7) ?? input.startDate?.slice(0, 7);
  if (!month || !/^\d{4}-\d{2}$/.test(month)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'settlementMonth or startDate is required.');
  const [year, monthNumber] = month.split('-').map(Number);
  if (monthNumber < 1 || monthNumber > 12) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'settlementMonth is invalid.');
  const monthDate = new Date(Date.UTC(year, monthNumber - 1, 1));
  const startDate = monthDate.toISOString().slice(0, 10);
  const endDate = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  if (input.startDate && input.startDate !== startDate) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Calibration startDate must be the first day of a month.');
  if (input.endDate && input.endDate !== endDate) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Calibration endDate must be the last day of the same month.');
  return monthDate;
}

function parseCredential(payload: unknown): EverflowCredentialPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Everflow credential payload is invalid.');
  const value = payload as Record<string, unknown>;
  const apiKey = nonBlank(value.apiKey);
  if (!apiKey) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Everflow API Key is required.');
  return { apiKey, baseUrl: nonBlank(value.baseUrl) ?? undefined };
}

function decimalOrNull(value: unknown) {
  if (!(['string', 'number'].includes(typeof value)) || String(value).trim() === '') return null;
  try { return new Prisma.Decimal(value as string | number); } catch { return null; }
}

function summarizeAttribution(
  rows: Array<{ subValue: string | null; revenueUsd: Prisma.Decimal }>,
  mappings: Array<{ subField: string; subValue: string; employeeId: string }>,
) {
  let attributedPositiveCount = 0;
  let unmatchedPositiveCount = 0;
  let blankPositiveCount = 0;
  let zeroRevenueCount = 0;
  for (const row of rows) {
    if (row.revenueUsd.isZero()) { zeroRevenueCount += 1; continue; }
    if (!row.subValue) { blankPositiveCount += 1; unmatchedPositiveCount += 1; continue; }
    const employees = new Set(mappings.filter((mapping) => mapping.subField === 'sub1' && mapping.subValue === row.subValue).map((mapping) => mapping.employeeId));
    if (employees.size === 1) attributedPositiveCount += 1;
    else unmatchedPositiveCount += 1;
  }
  return { configuredSub1MappingCount: mappings.filter((mapping) => mapping.subField === 'sub1').length, attributedPositiveCount, unmatchedPositiveCount, blankPositiveCount, zeroRevenueCount };
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
