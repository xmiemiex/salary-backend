import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../../audit/audit.service';
import { Actor } from '../../auth/auth.types';
import { CredentialReaderService } from '../../api-credentials/credential-reader.service';
import { AppError } from '../../common/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import { CakeClient, CakeConversionRecord, CakeCredentialPayload } from './cake-client';

const CALIBRATION_PAGE_SIZE = 100;
const CALIBRATION_MAX_PAGES = 2;

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
    const records: CakeConversionRecord[] = [];
    const pageReturnedCounts: number[] = [];
    const httpStatuses: number[] = [];
    let providerRowCount: number | null = null;
    for (let page = 0; page < CALIBRATION_MAX_PAGES; page += 1) {
      const response = await this.client.getConversions({
        credential,
        affiliateId: account.accountCode,
        startDate: range.startDate,
        endDate: range.endDate,
        startAtRow: page * CALIBRATION_PAGE_SIZE + 1,
        rowLimit: CALIBRATION_PAGE_SIZE,
      });
      records.push(...response.conversions);
      pageReturnedCounts.push(response.conversions.length);
      httpStatuses.push(response.httpStatus);
      providerRowCount = response.rowCount ?? providerRowCount;
      const moreRows =
        response.conversions.length === CALIBRATION_PAGE_SIZE &&
        (response.rowCount === null || records.length < response.rowCount);
      if (!moreRows) break;
    }
    const summary = summarize(records, providerRowCount, range, {
      pageReturnedCounts,
      httpStatuses,
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
  records: CakeConversionRecord[],
  rowCount: number | null,
  range: ReturnType<typeof parseRange>,
  pages: { pageReturnedCounts: number[]; httpStatuses: number[] },
) {
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
  return {
    requestRange: range,
    httpResult: {
      success: true,
      statuses: [...new Set(pages.httpStatuses)],
    },
    returnedCount: records.length,
    providerRowCount: rowCount,
    externalConversionIdHitCount: externalIds.length,
    duplicateExternalIdCount,
    subFieldHitCounts,
    payoutFieldHitCounts,
    dispositionDistribution,
    timestampSummary,
    pagination: {
      startAtRow: 1,
      rowLimit: CALIBRATION_PAGE_SIZE,
      pageCount: pages.pageReturnedCounts.length,
      pageReturnedCounts: pages.pageReturnedCounts,
      returnedCount: records.length,
      providerRowCount: rowCount,
      moreRowsPossible:
        pages.pageReturnedCounts.at(-1) === CALIBRATION_PAGE_SIZE ||
        (rowCount !== null && rowCount > records.length),
    },
    providerEndDateInclusivity: 'unconfirmed_requires_live_boundary_comparison',
    rawPayloadReturned: false,
  };
}

function nonBlank(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
