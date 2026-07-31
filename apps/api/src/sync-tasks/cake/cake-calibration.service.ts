import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../../audit/audit.service';
import { Actor } from '../../auth/auth.types';
import { CredentialReaderService } from '../../api-credentials/credential-reader.service';
import { AppError } from '../../common/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CakeCampaignSummaryRecord,
  CakeClient,
  CakeConversionRecord,
  CakeCredentialPayload,
  CakeCurrencyRecord,
  CakeDispositionTypeRecord,
} from './cake-client';

const CALIBRATION_PAGE_SIZE = 100;
const CALIBRATION_MAX_PAGES = 2;
const CALIBRATION_CAMPAIGN_ROW_LIMIT = 1000;

type ConversionWindowEvidence = {
  records: CakeConversionRecord[];
  providerRowCount: number | null;
  pageReturnedCounts: number[];
  httpStatuses: number[];
};

type CalibrationMapping = {
  subField: string;
  subValue: string;
  employeeId: string;
  employee: { employeeCode: string; name: string };
};

export type CakeCalibrationInput = {
  startDate?: string;
  endDate?: string;
};

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
    if (account.platform !== 'cake') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE calibration requires a cake affiliate account.');
    }
    const range = parseRange(input);
    const internal = await this.credentials.getAffiliateAccountCredentialPayload(account.id);
    const credential = parseCredential(internal.payload);
    const combined = await this.fetchConversionWindow(
      credential,
      account.accountCode,
      range.startDate,
      range.endDate,
      CALIBRATION_MAX_PAGES,
    );
    const startDay =
      range.startDate === range.endDate
        ? combined
        : await this.fetchConversionWindow(
            credential,
            account.accountCode,
            range.startDate,
            range.startDate,
            1,
          );
    const endDay =
      range.startDate === range.endDate
        ? combined
        : await this.fetchConversionWindow(
            credential,
            account.accountCode,
            range.endDate,
            range.endDate,
            1,
          );
    const [dispositionTypes, campaignSummary, currencies] = await Promise.all([
      this.client.getDispositionTypes({ credential, affiliateId: account.accountCode }),
      this.client.getCampaignSummary({
        credential,
        affiliateId: account.accountCode,
        startDate: range.startDate,
        endDate: range.endDate,
        rowLimit: CALIBRATION_CAMPAIGN_ROW_LIMIT,
      }),
      this.client.getCurrencies({ credential, affiliateId: account.accountCode }),
    ]);
    const mappingMonth = sameCalendarMonth(range.startDate, range.endDate)
      ? new Date(`${range.startDate.slice(0, 7)}-01T00:00:00.000Z`)
      : null;
    const mappings: CalibrationMapping[] = mappingMonth
      ? await this.prisma.subIdMapping.findMany({
          where: {
            affiliateAccountId: account.id,
            effectiveMonth: mappingMonth,
            status: CommonStatus.active,
          },
          select: {
            subField: true,
            subValue: true,
            employeeId: true,
            employee: { select: { employeeCode: true, name: true } },
          },
        })
      : [];
    const summary = summarize(combined, range, {
      startDay,
      endDay,
      dispositionTypes,
      campaignSummary,
      currencies,
      mappings,
      mappingMonth,
    });
    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'cake.connection_calibration.read',
      objectType: 'affiliate_accounts',
      objectId: account.id,
      afterData: summary,
      changedFields: [],
      requestPayload: range,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return {
      affiliateAccountId: account.id,
      accountName: account.accountName,
      affiliateId: account.accountCode,
      affiliateIdSource: 'affiliate_accounts.account_code',
      ...summary,
    };
  }

  private async fetchConversionWindow(
    credential: CakeCredentialPayload,
    affiliateId: string,
    startDate: string,
    endDate: string,
    maxPages: number,
  ): Promise<ConversionWindowEvidence> {
    const evidence: ConversionWindowEvidence = {
      records: [],
      providerRowCount: null,
      pageReturnedCounts: [],
      httpStatuses: [],
    };
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.client.getConversions({
        credential,
        affiliateId,
        startDate,
        endDate,
        startAtRow: page * CALIBRATION_PAGE_SIZE + 1,
        rowLimit: CALIBRATION_PAGE_SIZE,
      });
      evidence.records.push(...response.conversions);
      evidence.pageReturnedCounts.push(response.conversions.length);
      evidence.httpStatuses.push(response.httpStatus);
      evidence.providerRowCount = response.rowCount ?? evidence.providerRowCount;
      const moreRows =
        response.conversions.length === CALIBRATION_PAGE_SIZE &&
        (response.rowCount === null || evidence.records.length < response.rowCount);
      if (!moreRows) break;
    }
    return evidence;
  }
}

function parseRange(input: CakeCalibrationInput) {
  const startDate = parseDateOnly(input.startDate, 'startDate');
  const endDate = parseDateOnly(input.endDate, 'endDate');
  const start = new Date(`${startDate}T00:00:00+08:00`);
  const end = new Date(`${endDate}T23:59:59+08:00`);
  if (end < start || end.getTime() - start.getTime() > 2 * 24 * 60 * 60 * 1000) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Calibration window must be an inclusive range of at most 2 calendar days.');
  }
  return { startDate, endDate, timezone: 'Asia/Shanghai', readOnly: true as const };
}

function parseDateOnly(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must use YYYY-MM-DD.`);
  }
  return value;
}

function parseCredential(payload: unknown): CakeCredentialPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE credential payload is invalid.');
  }
  const value = payload as Record<string, unknown>;
  if (typeof value.apiKey !== 'string' || !value.apiKey.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE API Key is required.');
  }
  if (typeof value.baseUrl !== 'string' || !value.baseUrl.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CAKE API Base URL is required.');
  }
  return {
    apiKey: value.apiKey.trim(),
    baseUrl: value.baseUrl.trim(),
    conversionsPath: typeof value.conversionsPath === 'string' && value.conversionsPath.trim()
      ? value.conversionsPath.trim()
      : undefined,
  };
}

function summarize(
  combined: ConversionWindowEvidence,
  range: ReturnType<typeof parseRange>,
  auxiliary: {
    startDay: ConversionWindowEvidence;
    endDay: ConversionWindowEvidence;
    dispositionTypes: {
      rows: CakeDispositionTypeRecord[];
      rowCount: number | null;
      httpStatus: number;
    };
    campaignSummary: {
      rows: CakeCampaignSummaryRecord[];
      rowCount: number | null;
      httpStatus: number;
    };
    currencies: {
      rows: CakeCurrencyRecord[];
      rowCount: number | null;
      httpStatus: number;
    };
    mappings: CalibrationMapping[];
    mappingMonth: Date | null;
  },
) {
  const records = combined.records;
  const rowCount = combined.providerRowCount;
  const subFieldHitCounts = Object.fromEntries(
    [1, 2, 3, 4, 5].map((index) => [
      `subid_${index}`,
      records.filter((record) => nonBlank(record[`subid_${index}`])).length,
    ]),
  );
  const payoutFieldHitCounts = Object.fromEntries(
    ['price', 'payout', 'revenue'].map((field) => [field, records.filter((record) => record[field] !== undefined && record[field] !== null).length]),
  );
  const dispositionDistribution: Record<string, number> = {};
  for (const record of records) {
    const disposition = nonBlank(record.disposition) ?? '(missing)';
    dispositionDistribution[disposition] = (dispositionDistribution[disposition] ?? 0) + 1;
  }
  const timestampSummary = { explicitTimezone: 0, noTimezone: 0, missing: 0 };
  for (const record of records) {
    const timestamp = nonBlank(record.conversion_date);
    if (!timestamp) timestampSummary.missing += 1;
    else if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp)) timestampSummary.explicitTimezone += 1;
    else timestampSummary.noTimezone += 1;
  }
  const externalIds = records.map((record) => nonBlank(record.conversion_id)).filter((value): value is string => Boolean(value));
  const duplicateExternalIdCount = externalIds.length - new Set(externalIds).size;
  const dispositionTypes = auxiliary.dispositionTypes.rows.map((record) => ({
    id: finiteNumber(record.disposition_type_id),
    name: nonBlank(record.disposition_type_name),
  })).filter((record): record is { id: number | null; name: string } => Boolean(record.name));
  const currencyTypes = auxiliary.currencies.rows.map((record) => ({
    id: finiteNumber(record.currency_id),
    name: nonBlank(record.currency_name),
  })).filter((record): record is { id: number | null; name: string } => Boolean(record.name));
  const campaignCurrencyIds = uniqueNumbers(auxiliary.campaignSummary.rows.map((record) => record.currency_id));
  const campaignCurrencyNames = campaignCurrencyIds.map(
    (id) => currencyTypes.find((currency) => currency.id === id)?.name ?? `(unknown:${id})`,
  );
  const campaignCurrencySymbols = uniqueStrings(
    auxiliary.campaignSummary.rows.map((record) => record.currency_symbol),
  );
  const conversionPriceTotal = sumDecimal(records, 'price');
  const campaignRevenueTotal = sumDecimal(auxiliary.campaignSummary.rows, 'revenue');
  const conversionsComplete = rowCount !== null && rowCount <= records.length;
  const campaignComplete =
    auxiliary.campaignSummary.rowCount !== null &&
    auxiliary.campaignSummary.rowCount <= auxiliary.campaignSummary.rows.length;
  const totalsComparable =
    conversionsComplete &&
    campaignComplete &&
    conversionPriceTotal.validCount > 0 &&
    conversionPriceTotal.invalidCount === 0 &&
    campaignRevenueTotal.validCount > 0 &&
    campaignRevenueTotal.invalidCount === 0;
  const combinedIds = new Set(externalIds);
  const startIds = new Set(extractExternalIds(auxiliary.startDay.records));
  const endIds = new Set(extractExternalIds(auxiliary.endDay.records));
  const unionIds = new Set([...startIds, ...endIds]);
  const startComplete = isWindowComplete(auxiliary.startDay);
  const endComplete = isWindowComplete(auxiliary.endDay);
  const boundaryComparable =
    range.startDate !== range.endDate && conversionsComplete && startComplete && endComplete;
  const combinedEqualsSingleDayUnion =
    boundaryComparable && setsEqual(combinedIds, unionIds);
  const endDateObservedInclusive =
    boundaryComparable && endIds.size > 0 && [...endIds].every((id) => combinedIds.has(id));
  const timestampsWithinHalfOpenRange = records.every((record) => {
    const timestamp = nonBlank(record.conversion_date);
    if (!timestamp) return true;
    const datePrefix = timestamp.slice(0, 10);
    return datePrefix >= range.startDate && datePrefix < range.endDate;
  });
  const endDateObservedExclusive =
    boundaryComparable &&
    combinedIds.size > 0 &&
    startIds.size === 0 &&
    endIds.size === 0 &&
    timestampsWithinHalfOpenRange;
  const timestamps = records
    .map((record) => nonBlank(record.conversion_date))
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    requestRange: range,
    httpResult: {
      success: true,
      statuses: [...new Set([
        ...combined.httpStatuses,
        ...auxiliary.startDay.httpStatuses,
        ...auxiliary.endDay.httpStatuses,
        auxiliary.dispositionTypes.httpStatus,
        auxiliary.campaignSummary.httpStatus,
        auxiliary.currencies.httpStatus,
      ])],
      endpoints: {
        conversions: 'Reports/Conversions',
        campaignSummary: 'Reports/CampaignSummary',
        dispositionTypes: 'Lists/DispositionTypes',
        currencies: 'Lists/Currencies',
      },
    },
    returnedCount: records.length,
    providerRowCount: rowCount,
    externalConversionIdHitCount: externalIds.length,
    duplicateExternalIdCount,
    subFieldHitCounts,
    subAttributionEvidence: summarizeSubAttribution(
      records,
      auxiliary.mappings,
      auxiliary.mappingMonth,
    ),
    payoutFieldHitCounts,
    dispositionDistribution,
    timestampSummary,
    timestampEvidence: {
      earliest: timestamps[0] ?? null,
      latest: timestamps.at(-1) ?? null,
      startDayDatePrefixMismatchCount: countDatePrefixMismatches(auxiliary.startDay.records, range.startDate),
      endDayDatePrefixMismatchCount: countDatePrefixMismatches(auxiliary.endDay.records, range.endDate),
      timezoneSemantics: timestampSummary.noTimezone > 0
        ? 'unconfirmed_naive_provider_timestamp'
        : 'explicit_offset_observed',
    },
    dateBoundaryEvidence: {
      startDayReturnedCount: auxiliary.startDay.records.length,
      startDayProviderRowCount: auxiliary.startDay.providerRowCount,
      endDayReturnedCount: auxiliary.endDay.records.length,
      endDayProviderRowCount: auxiliary.endDay.providerRowCount,
      singleDayWindowsComplete: startComplete && endComplete,
      combinedEqualsSingleDayUnion,
      crossDayDuplicateExternalIdCount: [...startIds].filter((id) => endIds.has(id)).length,
      endDateInclusivity: endDateObservedInclusive
        ? 'observed_inclusive_for_sample'
        : endDateObservedExclusive
          ? 'observed_exclusive_for_sample'
          : 'unconfirmed_requires_more_evidence',
    },
    dispositionTypeEvidence: {
      httpStatus: auxiliary.dispositionTypes.httpStatus,
      returnedCount: dispositionTypes.length,
      providerRowCount: auxiliary.dispositionTypes.rowCount,
      types: dispositionTypes,
      conversionDispositionMissingCount: dispositionDistribution['(missing)'] ?? 0,
      payablePolicyConfirmed: false,
    },
    payoutEvidence: {
      conversionPriceTotal: conversionPriceTotal.value,
      conversionPriceValidCount: conversionPriceTotal.validCount,
      conversionPriceInvalidCount: conversionPriceTotal.invalidCount,
      campaignRevenueTotal: campaignRevenueTotal.value,
      campaignRevenueValidCount: campaignRevenueTotal.validCount,
      campaignRevenueInvalidCount: campaignRevenueTotal.invalidCount,
      conversionsComplete,
      campaignSummaryComplete: campaignComplete,
      sameWindowTotalsEqual: totalsComparable
        ? new Prisma.Decimal(conversionPriceTotal.value as string).equals(
            new Prisma.Decimal(campaignRevenueTotal.value as string),
          )
        : null,
      comparisonBasis: 'Reports/Conversions.price versus Reports/CampaignSummary.revenue for the same account and date window',
    },
    currencyEvidence: {
      httpStatus: auxiliary.currencies.httpStatus,
      campaignCurrencyIds,
      campaignCurrencyNames,
      campaignCurrencySymbols,
      usdConfirmed:
        campaignCurrencyNames.length > 0 &&
        campaignCurrencyNames.every((name) => /(^|\b)(USD|US Dollar)(\b|$)/i.test(name)),
      conversionRowsContainCurrency: records.some((record) => nonBlank(record.currency ?? record.currency_code)),
    },
    pagination: {
      startAtRow: 1,
      rowLimit: CALIBRATION_PAGE_SIZE,
      pageCount: combined.pageReturnedCounts.length,
      pageReturnedCounts: combined.pageReturnedCounts,
      returnedCount: records.length,
      providerRowCount: rowCount,
      moreRowsPossible:
        combined.pageReturnedCounts.at(-1) === CALIBRATION_PAGE_SIZE ||
        (rowCount !== null && rowCount > records.length),
    },
    rawPayloadReturned: false,
  };
}

function summarizeSubAttribution(
  records: CakeConversionRecord[],
  mappings: CalibrationMapping[],
  mappingMonth: Date | null,
) {
  if (!mappingMonth) {
    return {
      readOnly: true,
      evaluationSupported: false,
      reason: 'calibration_range_crosses_settlement_month',
      effectiveMonth: null,
      configuredMappingCount: 0,
      recordsWithSubCount: null,
      attributedRecordCount: null,
      noSubRecordCount: null,
      unmappedRecordCount: null,
      conflictingEmployeeRecordCount: null,
      mappingMatchCounts: [],
    };
  }

  let recordsWithSubCount = 0;
  let attributedRecordCount = 0;
  let noSubRecordCount = 0;
  let unmappedRecordCount = 0;
  let conflictingEmployeeRecordCount = 0;
  const matchCounts = new Array<number>(mappings.length).fill(0);

  for (const record of records) {
    const candidates = [1, 2, 3, 4, 5]
      .map((index) => ({ subField: `sub${index}`, subValue: nonBlank(record[`subid_${index}`]) }))
      .filter((candidate): candidate is { subField: string; subValue: string } => Boolean(candidate.subValue));
    if (candidates.length === 0) {
      noSubRecordCount += 1;
      continue;
    }
    recordsWithSubCount += 1;
    const matchedIndexes = mappings
      .map((mapping, index) => ({ mapping, index }))
      .filter(({ mapping }) => candidates.some(
        (candidate) => candidate.subField === mapping.subField && candidate.subValue === mapping.subValue,
      ));
    if (matchedIndexes.length === 0) {
      unmappedRecordCount += 1;
      continue;
    }
    matchedIndexes.forEach(({ index }) => { matchCounts[index] += 1; });
    const employeeIds = new Set(matchedIndexes.map(({ mapping }) => mapping.employeeId));
    if (employeeIds.size > 1) {
      conflictingEmployeeRecordCount += 1;
      continue;
    }
    attributedRecordCount += 1;
  }

  return {
    readOnly: true,
    evaluationSupported: true,
    reason: null,
    effectiveMonth: mappingMonth.toISOString().slice(0, 10),
    configuredMappingCount: mappings.length,
    recordsWithSubCount,
    attributedRecordCount,
    noSubRecordCount,
    unmappedRecordCount,
    conflictingEmployeeRecordCount,
    mappingMatchCounts: mappings.map((mapping, index) => ({
      subField: mapping.subField,
      subValue: mapping.subValue,
      employeeCode: mapping.employee.employeeCode,
      employeeName: mapping.employee.name,
      recordCount: matchCounts[index],
    })),
  };
}

function sameCalendarMonth(startDate: string, endDate: string) {
  return startDate.slice(0, 7) === endDate.slice(0, 7);
}

function extractExternalIds(records: CakeConversionRecord[]): string[] {
  return records
    .map((record) => nonBlank(record.conversion_id))
    .filter((value): value is string => Boolean(value));
}

function isWindowComplete(window: ConversionWindowEvidence): boolean {
  return window.providerRowCount !== null && window.providerRowCount <= window.records.length;
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function countDatePrefixMismatches(records: CakeConversionRecord[], date: string): number {
  return records.filter((record) => {
    const timestamp = nonBlank(record.conversion_date);
    return !timestamp || timestamp.slice(0, 10) !== date;
  }).length;
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map(nonBlank).filter((value): value is string => Boolean(value)))];
}

function uniqueNumbers(values: unknown[]): number[] {
  return [...new Set(values.map(finiteNumber).filter((value): value is number => value !== null))];
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function sumDecimal(records: Array<Record<string, unknown>>, field: string) {
  let total = new Prisma.Decimal(0);
  let validCount = 0;
  let invalidCount = 0;
  for (const record of records) {
    const raw = record[field];
    if (raw === undefined || raw === null || raw === '') continue;
    try {
      total = total.plus(new Prisma.Decimal(raw as string | number));
      validCount += 1;
    } catch {
      invalidCount += 1;
    }
  }
  return { value: validCount > 0 ? total.toString() : null, validCount, invalidCount };
}

function nonBlank(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
