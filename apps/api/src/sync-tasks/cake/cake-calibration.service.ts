import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { CredentialReaderService } from '../../api-credentials/credential-reader.service';
import { AuditService } from '../../audit/audit.service';
import { Actor } from '../../auth/auth.types';
import { AppError } from '../../common/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import { CakeClient, CakeCredentialPayload } from './cake-client';
import {
  CAKE_MONTHLY_SUB_CALIBRATION_ACTION,
  CAKE_MONTHLY_SUB_CALIBRATION_READ_ACTION,
  normalizeCakeSummaryRow,
} from './cake-income-sync.adapter';

export type CakeCalibrationInput = { startDate?: string; endDate?: string; settlementMonth?: string };

@Injectable()
export class CakeCalibrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialReaderService,
    private readonly client: CakeClient,
    private readonly audit: AuditService,
  ) {}

  async run(affiliateAccountId: string, input: CakeCalibrationInput, actor: Actor) {
    const account = await this.prisma.affiliateAccount.findUnique({
      where: { id: affiliateAccountId },
      select: { id: true, platform: true, accountCode: true, accountName: true },
    });
    if (!account) throw new AppError(ERROR_CODES.NOT_FOUND, 'Affiliate account not found.');
    if (account.platform !== 'cake') throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE calibration requires a cake affiliate account.');

    const range = parseFullMonthRange(input);
    const internal = await this.credentials.getAffiliateAccountCredentialPayload(account.id);
    const credential = parseCredential(internal.payload);
    const [summary, campaignSummary, currencies, mappings] = await Promise.all([
      this.client.getSubAffiliateSummary({
        credential,
        affiliateId: account.accountCode,
        startDate: `${range.startDate}T00:00:00`,
        endDate: `${range.endExclusiveDate}T00:00:00`,
      }),
      this.client.getCampaignSummary({
        credential,
        affiliateId: account.accountCode,
        startDate: `${range.startDate}T00:00:00`,
        endDate: `${range.endExclusiveDate}T00:00:00`,
        rowLimit: 1000,
      }),
      this.client.getCurrencies({ credential, affiliateId: account.accountCode }),
      this.prisma.subIdMapping.findMany({
        where: { affiliateAccountId: account.id, effectiveMonth: range.monthDate, status: CommonStatus.active },
        select: { subField: true, subValue: true, employeeId: true },
      }),
    ]);

    const rows = summary.rows.map(normalizeCakeSummaryRow);
    const aggregatedRows = aggregateRows(rows);
    const summaryRevenue = rows.reduce((total, row) => total.plus(row.revenueUsd), new Prisma.Decimal(0));
    const campaignRevenue = sumDecimal(campaignSummary.rows.map((row) => row.revenue));
    const currencyEvidence = resolveCurrencyEvidence(campaignSummary.rows, currencies.rows);
    const summaryComplete = summary.rowCount === null || summary.rowCount <= summary.rows.length;
    const campaignComplete = campaignSummary.rowCount === null || campaignSummary.rowCount <= campaignSummary.rows.length;
    const totalsEqual = campaignRevenue !== null && campaignRevenue.equals(summaryRevenue);
    const usdConfirmed = currencyEvidence.names.length > 0 && currencyEvidence.names.every((name) => /(^|\b)(USD|US Dollar)(\b|$)/i.test(name));
    const attribution = summarizeAttribution(aggregatedRows, mappings);
    const duplicateSubValues = duplicateKeys(rows);
    const acceptanceBaseline = task96AcceptanceBaseline(account.accountCode, range.startDate.slice(0, 7), aggregatedRows);
    const writeGateEligible = summaryComplete && campaignComplete && totalsEqual && usdConfirmed && acceptanceBaseline.matches !== false;
    const evidence = {
      readOnly: true,
      rawPayloadReturned: false,
      writeGateEligible,
      affiliateAccountId: account.id,
      accountName: account.accountName,
      affiliateId: account.accountCode,
      affiliateIdSource: 'affiliate_accounts.account_code',
      report: 'Reports/SubAffiliateSummary',
      timezone: 'China Standard Time',
      requestRange: { startInclusive: `${range.startDate}T00:00:00`, endExclusive: `${range.endExclusiveDate}T00:00:00` },
      httpStatuses: [summary.httpStatus, campaignSummary.httpStatus, currencies.httpStatus],
      returnedCount: rows.length,
      uniqueSubCount: aggregatedRows.length,
      duplicateSubValues,
      providerRowCount: summary.rowCount,
      summaryComplete,
      campaignSummaryComplete: campaignComplete,
      revenue: {
        currency: usdConfirmed ? 'USD' : null,
        subAffiliateSummaryTotal: summaryRevenue.toString(),
        campaignSummaryTotal: campaignRevenue?.toString() ?? null,
        sameWindowTotalsEqual: totalsEqual,
      },
      currencyEvidence,
      rows: aggregatedRows.map((row) => ({ subField: 'sub1', subValue: row.subValue, revenue: row.revenueUsd.toString() })),
      attribution,
      acceptanceBaseline,
    };

    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: writeGateEligible ? CAKE_MONTHLY_SUB_CALIBRATION_ACTION : CAKE_MONTHLY_SUB_CALIBRATION_READ_ACTION,
      objectType: 'affiliate_accounts',
      objectId: account.id,
      afterData: evidence,
      changedFields: [],
      requestPayload: { startDate: range.startDate, endDate: range.endDate },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return evidence;
  }
}

function parseFullMonthRange(input: CakeCalibrationInput) {
  const month = input.settlementMonth?.slice(0, 7) ?? input.startDate?.slice(0, 7);
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'settlementMonth or startDate is required.');
  }
  const [year, monthNumber] = month.split('-').map(Number);
  if (monthNumber < 1 || monthNumber > 12) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'settlementMonth is invalid.');
  const monthDate = new Date(Date.UTC(year, monthNumber - 1, 1));
  const startDate = formatDate(monthDate);
  const endDate = formatDate(new Date(Date.UTC(year, monthNumber, 0)));
  const endExclusiveDate = formatDate(new Date(Date.UTC(year, monthNumber, 1)));
  if (input.startDate && input.startDate !== startDate) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Calibration startDate must be the first day of a month.');
  if (input.endDate && input.endDate !== endDate) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Calibration endDate must be the last day of the same month.');
  return { monthDate, startDate, endDate, endExclusiveDate };
}

function parseCredential(payload: unknown): CakeCredentialPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE credential payload is invalid.');
  const value = payload as Record<string, unknown>;
  const apiKey = nonBlank(value.apiKey);
  const baseUrl = nonBlank(value.baseUrl);
  if (!apiKey || !baseUrl) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE API Key and Base URL are required.');
  return { apiKey, baseUrl, conversionsPath: nonBlank(value.conversionsPath) ?? undefined };
}

function sumDecimal(values: unknown[]) {
  try {
    let total = new Prisma.Decimal(0);
    let count = 0;
    for (const value of values) {
      if (value === null || value === undefined || value === '') continue;
      total = total.plus(new Prisma.Decimal(value as string | number));
      count += 1;
    }
    return count > 0 ? total : null;
  } catch {
    return null;
  }
}

function resolveCurrencyEvidence(campaignRows: Record<string, unknown>[], currencyRows: Record<string, unknown>[]) {
  const ids = [...new Set(campaignRows.map((row) => finiteNumber(row.currency_id)).filter((value): value is number => value !== null))];
  const names = ids.map((id) => {
    const currency = currencyRows.find((row) => finiteNumber(row.currency_id) === id);
    return nonBlank(currency?.currency_name) ?? nonBlank(currency?.name) ?? `(unknown:${id})`;
  });
  const symbols = [...new Set(campaignRows.map((row) => nonBlank(row.currency_symbol)).filter((value): value is string => Boolean(value)))];
  return { ids, names, symbols };
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

function aggregateRows(rows: Array<{ subValue: string | null; revenueUsd: Prisma.Decimal }>) {
  const totals = new Map<string, { subValue: string | null; revenueUsd: Prisma.Decimal }>();
  for (const row of rows) {
    const key = row.subValue ?? '';
    const current = totals.get(key);
    totals.set(key, current ? { ...row, revenueUsd: current.revenueUsd.plus(row.revenueUsd) } : row);
  }
  return [...totals.values()];
}

function duplicateKeys(rows: Array<{ subValue: string | null }>) {
  const counts = new Map<string, number>();
  rows.forEach((row) => counts.set(row.subValue ?? '', (counts.get(row.subValue ?? '') ?? 0) + 1));
  return [...counts.entries()].filter(([, count]) => count > 1).map(([subValue, count]) => ({ subValue: subValue || null, count }));
}

function task96AcceptanceBaseline(
  affiliateId: string,
  month: string,
  rows: Array<{ subValue: string | null; revenueUsd: Prisma.Decimal }>,
) {
  if (affiliateId !== '329' || month !== '2026-07') return { applicable: false, matches: null, differences: [] };
  const expected = new Map<string, Prisma.Decimal>([
    ['ZW', new Prisma.Decimal(77710)],
    ['YDF', new Prisma.Decimal(2600)],
    ['MSY', new Prisma.Decimal(585)],
    ['DAN', new Prisma.Decimal(4420)],
    ['RRR', new Prisma.Decimal(0)],
    ['PEI', new Prisma.Decimal(0)],
    ['JKY', new Prisma.Decimal(0)],
    ['', new Prisma.Decimal(195)],
  ]);
  const actual = new Map(rows.map((row) => [row.subValue ?? '', row.revenueUsd]));
  const keys = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  const differences = keys.flatMap((key) => {
    const expectedRevenue = expected.get(key);
    const actualRevenue = actual.get(key);
    if (expectedRevenue !== undefined && actualRevenue !== undefined && expectedRevenue.equals(actualRevenue)) return [];
    return [{
      subValue: key || null,
      expectedRevenue: expectedRevenue?.toString() ?? null,
      actualRevenue: actualRevenue?.toString() ?? null,
      delta: expectedRevenue !== undefined && actualRevenue !== undefined ? actualRevenue.minus(expectedRevenue).toString() : null,
    }];
  });
  return {
    applicable: true,
    source: 'task96_confirmed_2026_07_business_baseline',
    expectedTotalRevenue: '85510',
    matches: differences.length === 0,
    differences,
  };
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}
