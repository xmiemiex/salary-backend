import { Injectable } from '@nestjs/common';
import {
  Prisma,
  Provider,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskType,
  SyncUnmatchedEventStatus,
} from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { optionalNonBlank, requireNonBlank } from '../base-data/base-data.utils';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';

type UnmatchedPrismaClient = PrismaService | Prisma.TransactionClient;

const AFFILIATE_PLATFORMS = [SyncTaskPlatform.everflow, SyncTaskPlatform.cake] as const;
const CARD_PROVIDERS = [Provider.airwallex, Provider.photonpay] as const;
const SOURCE_TYPES = [SyncTaskSourceType.affiliate_income, SyncTaskSourceType.card_spend] as const;
const STATUSES = [
  SyncUnmatchedEventStatus.open,
  SyncUnmatchedEventStatus.ignored,
  SyncUnmatchedEventStatus.resolved,
] as const;
const REASON_CODES = [
  'SUB_ID_MISSING',
  'SUB_ID_NOT_MAPPED',
  'SUB_ID_EMPLOYEE_CONFLICT',
  'CARD_ID_MISSING',
  'CARD_NOT_MAPPED',
  'EMPLOYEE_DISABLED',
  'INVALID_CURRENCY',
  'OUTSIDE_SETTLEMENT_WINDOW',
  'DUPLICATE_SKIPPED',
  'UNKNOWN',
] as const;
const SECRET_FIELD_PATTERN = /apiKey|token|secret|clientId|merchantId|authorization|signature|password|encryptedPayload/i;
const RAW_SAFE_KEYS = new Set([
  'id',
  'eventId',
  'conversionId',
  'transactionId',
  'status',
  'conversionStatus',
  'sourceStatus',
  'settleStatus',
  'transactionType',
  'fundDirection',
  'affiliateAccountId',
  'sub1',
  'sub2',
  'sub3',
  'sub4',
  'sub5',
  'subField',
  'subValue',
  'cardId',
  'cardLast4',
  'cardEmail',
  'amount',
  'amountUsd',
  'currency',
  'occurredAt',
  'conversionTime',
  'transactionAt',
  'settledAt',
  'error',
  'message',
  'reason',
]);

export type SyncUnmatchedEventsQuery = {
  settlementMonth?: string;
  sourceType?: string;
  status?: string;
  platform?: string;
  provider?: string;
  affiliateAccountId?: string;
  reasonCode?: string;
  page?: string;
  pageSize?: string;
};

export type RecordUnmatchedEventInput = {
  settlementMonth: string | Date;
  sourceType: string;
  taskType: string;
  platform?: string | null;
  provider?: string | null;
  affiliateAccountId?: string | null;
  syncTaskId?: string | null;
  thirdPartyEventId?: string | null;
  reasonCode: string;
  reasonMessage?: string | null;
  subField?: string | null;
  subValue?: string | null;
  cardId?: string | null;
  cardLast4?: string | null;
  cardEmail?: string | null;
  amountUsd?: string | number | Prisma.Decimal | null;
  currency?: string | null;
  occurredAt?: string | Date | null;
  rawSafeData?: Prisma.InputJsonValue | null;
  rawData?: Prisma.InputJsonValue | null;
};

export type UpdateSyncUnmatchedEventResolutionInput = {
  resolutionNote?: string | null;
};

export type ResolveSyncUnmatchedEventInput = UpdateSyncUnmatchedEventResolutionInput & {
  resolvedEmployeeId?: string;
};

export type ResolveAfterSuccessfulImportInput = {
  settlementMonth: string | Date;
  thirdPartyEventId: string;
  employeeId: string;
  resolvedBy?: string | null;
} & (
  | {
    sourceType: 'affiliate_income';
    taskType: 'affiliate_income';
    platform: SyncTaskPlatform;
    affiliateAccountId: string;
    subField: string;
    subValue: string;
  }
  | {
    sourceType: 'card_spend';
    taskType: 'airwallex_card' | 'photonpay_card';
    provider: Provider;
    cardId: string;
  }
);

type UnmatchedEventWithRelations = Prisma.SyncUnmatchedEventGetPayload<{
  include: {
    affiliateAccount: { select: { id: true; platform: true; accountCode: true; accountName: true } };
    resolvedEmployee: { select: { id: true; name: true } };
  };
}>;

@Injectable()
export class SyncUnmatchedEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: SyncUnmatchedEventsQuery = {}) {
    const settlementMonth = parseSettlementMonth(query.settlementMonth, 'settlementMonth');
    const page = parsePositiveInt(query.page, 'page', 1, 1, 100000);
    const pageSize = parsePositiveInt(query.pageSize, 'pageSize', 50, 1, 500);
    const where: Prisma.SyncUnmatchedEventWhereInput = {
      settlementMonth,
      sourceType: query.sourceType ? enumValue(SyncTaskSourceType, query.sourceType, 'sourceType') : undefined,
      status: query.status ? enumValue(SyncUnmatchedEventStatus, query.status, 'status') : undefined,
      platform: query.platform ? parseAffiliatePlatform(query.platform) : undefined,
      provider: query.provider ? parseProvider(query.provider) : undefined,
      affiliateAccountId: optionalNonBlank(query.affiliateAccountId, 'affiliateAccountId'),
      reasonCode: query.reasonCode ? parseReasonCode(query.reasonCode) : undefined,
    };

    const [total, items, summaryAggregate, statusCounts, reasonCounts, sourceTypeCounts] = await this.prisma.$transaction([
      this.prisma.syncUnmatchedEvent.count({ where }),
      this.prisma.syncUnmatchedEvent.findMany({
        where,
        include: includeRelations(),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.syncUnmatchedEvent.aggregate({ where, _sum: { amountUsd: true }, _count: { _all: true } }),
      this.prisma.syncUnmatchedEvent.groupBy({
        by: ['status'],
        where,
        orderBy: { status: 'asc' },
        _count: { _all: true },
      }),
      this.prisma.syncUnmatchedEvent.groupBy({
        by: ['reasonCode'],
        where,
        orderBy: { reasonCode: 'asc' },
        _count: { _all: true },
      }),
      this.prisma.syncUnmatchedEvent.groupBy({
        by: ['sourceType'],
        where,
        orderBy: { sourceType: 'asc' },
        _count: { _all: true },
      }),
    ]);

    return {
      items: items.map(toDto),
      total,
      page,
      pageSize,
      summary: {
        totalCount: summaryAggregate._count._all,
        openCount: countBy(statusCounts, 'status', SyncUnmatchedEventStatus.open),
        ignoredCount: countBy(statusCounts, 'status', SyncUnmatchedEventStatus.ignored),
        resolvedCount: countBy(statusCounts, 'status', SyncUnmatchedEventStatus.resolved),
        totalAmountUsd: decimalToString(summaryAggregate._sum.amountUsd),
        byReasonCode: groupCountMap(reasonCounts, 'reasonCode'),
        bySourceType: groupCountMap(sourceTypeCounts, 'sourceType'),
      },
    };
  }

  async recordUnmatchedEvent(
    input: RecordUnmatchedEventInput,
    prisma: UnmatchedPrismaClient = this.prisma,
  ) {
    const data = validateRecordInput(input);
    if (data.thirdPartyEventId) {
      const existing = await prisma.syncUnmatchedEvent.findUnique({
        where: {
          sourceType_taskType_thirdPartyEventId: {
            sourceType: data.sourceType,
            taskType: data.taskType,
            thirdPartyEventId: data.thirdPartyEventId,
          },
        },
        include: includeRelations(),
      });
      if (existing) {
        if (existing.status !== SyncUnmatchedEventStatus.open) return toDto(existing);
        const updated = await prisma.syncUnmatchedEvent.update({
          where: { id: existing.id },
          data,
          include: includeRelations(),
        });
        return toDto(updated);
      }
    }

    const created = await prisma.syncUnmatchedEvent.create({ data, include: includeRelations() });
    return toDto(created);
  }

  async resolveAfterSuccessfulImport(
    input: ResolveAfterSuccessfulImportInput,
    prisma: UnmatchedPrismaClient = this.prisma,
  ) {
    const existing = await prisma.syncUnmatchedEvent.findUnique({
      where: {
        sourceType_taskType_thirdPartyEventId: {
          sourceType: input.sourceType,
          taskType: input.taskType,
          thirdPartyEventId: input.thirdPartyEventId,
        },
      },
      select: {
        id: true,
        status: true,
        settlementMonth: true,
        platform: true,
        provider: true,
        affiliateAccountId: true,
        subField: true,
        subValue: true,
        cardId: true,
      },
    });
    if (
      !existing
      || existing.status !== SyncUnmatchedEventStatus.open
      || !matchesSuccessfulImport(existing, input)
    ) return false;
    await prisma.syncUnmatchedEvent.update({
      where: { id: existing.id },
      data: {
        status: SyncUnmatchedEventStatus.resolved,
        resolvedEmployeeId: input.employeeId,
        resolvedAt: new Date(),
        resolvedBy: input.resolvedBy ?? null,
        resolutionNote: 'Automatically resolved after a successful idempotent re-sync.',
      },
    });
    return true;
  }

  async ignore(id: string, input: UpdateSyncUnmatchedEventResolutionInput, actor: Actor) {
    const before = await this.getForUpdate(id);
    const data = {
      status: SyncUnmatchedEventStatus.ignored,
      resolvedAt: new Date(),
      resolvedBy: actor.userId,
      resolutionNote: optionalNote(input.resolutionNote),
    };
    // Locked settlement months are intentionally allowed here: this marks a reconciliation event only
    // and does not create or mutate salary, income, card-spend, or settlement data.
    const after = await this.prisma.syncUnmatchedEvent.update({ where: { id }, data, include: includeRelations() });
    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'sync_unmatched_event.ignore',
      objectType: 'sync_unmatched_events',
      objectId: id,
      settlementMonth: before.settlementMonth,
      beforeData: before,
      afterData: after,
      changedFields: ['status', 'resolvedAt', 'resolvedBy', 'resolutionNote'],
      requestPayload: input,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return toDto(after);
  }

  async resolve(id: string, input: ResolveSyncUnmatchedEventInput, actor: Actor) {
    const before = await this.getForUpdate(id);
    const resolvedEmployeeId = requireNonBlank(input.resolvedEmployeeId, 'resolvedEmployeeId');
    const employee = await this.prisma.employee.findUnique({ where: { id: resolvedEmployeeId }, select: { id: true } });
    if (!employee) throw new AppError(ERROR_CODES.NOT_FOUND, 'Employee not found.');

    const data = {
      status: SyncUnmatchedEventStatus.resolved,
      resolvedEmployeeId,
      resolvedAt: new Date(),
      resolvedBy: actor.userId,
      resolutionNote: optionalNote(input.resolutionNote),
    };
    // Resolution is metadata only. It deliberately does not backfill income_records/card_spend_events
    // and therefore does not affect locked salary data.
    const after = await this.prisma.syncUnmatchedEvent.update({ where: { id }, data, include: includeRelations() });
    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'sync_unmatched_event.resolve',
      objectType: 'sync_unmatched_events',
      objectId: id,
      settlementMonth: before.settlementMonth,
      beforeData: before,
      afterData: after,
      changedFields: ['status', 'resolvedEmployeeId', 'resolvedAt', 'resolvedBy', 'resolutionNote'],
      requestPayload: input,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return toDto(after);
  }

  private async getForUpdate(id: string) {
    const event = await this.prisma.syncUnmatchedEvent.findUnique({ where: { id }, include: includeRelations() });
    if (!event) throw new AppError(ERROR_CODES.NOT_FOUND, 'Sync unmatched event not found.');
    return event;
  }
}

function matchesSuccessfulImport(
  existing: {
    settlementMonth: Date;
    platform: SyncTaskPlatform | null;
    provider: Provider | null;
    affiliateAccountId: string | null;
    subField: string | null;
    subValue: string | null;
    cardId: string | null;
  },
  input: ResolveAfterSuccessfulImportInput,
): boolean {
  if (existing.settlementMonth.getTime() !== parseSettlementMonth(input.settlementMonth, 'settlementMonth').getTime()) {
    return false;
  }
  if (input.sourceType === SyncTaskSourceType.affiliate_income) {
    return existing.platform === input.platform
      && existing.provider === null
      && existing.affiliateAccountId === input.affiliateAccountId
      && existing.subField === input.subField
      && existing.subValue === input.subValue
      && existing.cardId === null;
  }
  return existing.provider === input.provider
    && existing.platform === null
    && existing.affiliateAccountId === null
    && existing.cardId === input.cardId
    && existing.subField === null
    && existing.subValue === null;
}

function validateRecordInput(input: RecordUnmatchedEventInput): Prisma.SyncUnmatchedEventCreateInput {
  const sourceType = enumValue(SyncTaskSourceType, input.sourceType, 'sourceType');
  const taskType = enumValue(SyncTaskType, input.taskType, 'taskType');
  if (!SOURCE_TYPES.includes(sourceType as (typeof SOURCE_TYPES)[number])) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'sourceType must be affiliate_income or card_spend.');
  }
  if (sourceType === SyncTaskSourceType.affiliate_income && taskType !== SyncTaskType.affiliate_income) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'affiliate_income sourceType requires affiliate_income taskType.');
  }
  if (sourceType === SyncTaskSourceType.card_spend && taskType === SyncTaskType.affiliate_income) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'card_spend sourceType requires a card taskType.');
  }

  const provider = input.provider ? parseProvider(input.provider) : undefined;
  if (sourceType === SyncTaskSourceType.card_spend && !provider) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'provider is required for card_spend unmatched events.');
  }
  const platform = input.platform ? parseAffiliatePlatform(input.platform) : undefined;
  if (sourceType === SyncTaskSourceType.affiliate_income && !platform) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'platform is required for affiliate_income unmatched events.');
  }

  const rawCandidate = input.rawSafeData ?? input.rawData ?? null;
  const rawSafeData = sanitizeRawSafeData(rawCandidate);
  return {
    settlementMonth: parseSettlementMonth(input.settlementMonth, 'settlementMonth'),
    sourceType,
    taskType,
    platform,
    provider,
    affiliateAccount: connectOptional(input.affiliateAccountId),
    syncTask: connectOptional(input.syncTaskId),
    thirdPartyEventId: optionalNonBlank(input.thirdPartyEventId, 'thirdPartyEventId'),
    reasonCode: parseReasonCode(input.reasonCode),
    reasonMessage: optionalNonBlank(input.reasonMessage, 'reasonMessage'),
    subField: optionalNonBlank(input.subField, 'subField'),
    subValue: optionalNonBlank(input.subValue, 'subValue'),
    cardId: optionalNonBlank(input.cardId, 'cardId'),
    cardLast4: optionalNonBlank(input.cardLast4, 'cardLast4'),
    cardEmail: optionalNonBlank(input.cardEmail, 'cardEmail'),
    amountUsd: parseOptionalDecimal(input.amountUsd, 'amountUsd'),
    currency: optionalNonBlank(input.currency, 'currency'),
    occurredAt: parseOptionalDate(input.occurredAt, 'occurredAt'),
    rawSafeData,
    status: SyncUnmatchedEventStatus.open,
  };
}

function includeRelations() {
  return {
    affiliateAccount: { select: { id: true, platform: true, accountCode: true, accountName: true } },
    resolvedEmployee: { select: { id: true, name: true } },
  } satisfies Prisma.SyncUnmatchedEventInclude;
}

function toDto(event: UnmatchedEventWithRelations) {
  return {
    id: event.id,
    settlementMonth: event.settlementMonth.toISOString().slice(0, 10),
    sourceType: event.sourceType,
    taskType: event.taskType,
    platform: normalizeAffiliatePlatform(event.platform),
    provider: event.provider,
    affiliateAccountId: event.affiliateAccountId,
    affiliateAccountName: event.affiliateAccount?.accountName ?? event.affiliateAccount?.accountCode ?? null,
    affiliateAccountCode: event.affiliateAccount?.accountCode ?? null,
    syncTaskId: event.syncTaskId,
    thirdPartyEventId: event.thirdPartyEventId,
    reasonCode: event.reasonCode,
    reasonMessage: event.reasonMessage,
    subField: event.subField,
    subValue: event.subValue,
    cardId: event.cardId,
    cardLast4: event.cardLast4,
    cardEmail: event.cardEmail,
    amountUsd: decimalToString(event.amountUsd),
    currency: event.currency,
    occurredAt: event.occurredAt,
    rawSafeData: event.rawSafeData,
    status: event.status,
    resolvedEmployeeId: event.resolvedEmployeeId,
    resolvedEmployeeName: event.resolvedEmployee?.name ?? null,
    resolutionNote: event.resolutionNote,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    resolvedAt: event.resolvedAt,
    resolvedBy: event.resolvedBy,
  };
}

function parseSettlementMonth(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a valid date.`);
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1, 0, 0, 0, 0));
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is required.`);
  }
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value.trim());
  if (!match || (match[3] !== undefined && match[3] !== '01')) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must use YYYY-MM or YYYY-MM-01 format.`);
  }
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must use YYYY-MM or YYYY-MM-01 format.`);
  }
  return new Date(Date.UTC(Number(match[1]), monthIndex, 1, 0, 0, 0, 0));
}

function parseOptionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a valid date.`);
  return date;
}

function parseOptionalDecimal(value: unknown, field: string): Prisma.Decimal | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    const decimal = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value as string | number);
    if (!decimal.isFinite()) throw new Error('not finite');
    return decimal;
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a valid decimal.`);
  }
}

function parsePositiveInt(value: unknown, field: string, defaultValue: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function enumValue<T extends Record<string, string>>(enumObject: T, value: string, field: string): T[keyof T] {
  if (Object.values(enumObject).includes(value)) return value as T[keyof T];
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is invalid.`);
}

function parseAffiliatePlatform(value: string): (typeof AFFILIATE_PLATFORMS)[number] {
  const platform = value.trim().toLowerCase();
  if (AFFILIATE_PLATFORMS.includes(platform as (typeof AFFILIATE_PLATFORMS)[number])) {
    return platform as (typeof AFFILIATE_PLATFORMS)[number];
  }
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'platform must be everflow or cake.');
}

function parseProvider(value: string): (typeof CARD_PROVIDERS)[number] {
  const provider = value.trim().toLowerCase();
  if (CARD_PROVIDERS.includes(provider as (typeof CARD_PROVIDERS)[number])) {
    return provider as (typeof CARD_PROVIDERS)[number];
  }
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'provider must be airwallex or photonpay.');
}

function parseReasonCode(value: string): string {
  const reasonCode = requireNonBlank(value, 'reasonCode').toUpperCase();
  if (!REASON_CODES.includes(reasonCode as (typeof REASON_CODES)[number])) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'reasonCode is invalid.');
  }
  return reasonCode;
}

function normalizeAffiliatePlatform(value: SyncTaskPlatform | null): 'everflow' | 'cake' | null {
  return value === SyncTaskPlatform.everflow || value === SyncTaskPlatform.cake ? value : null;
}

function connectOptional(id: unknown): { connect: { id: string } } | undefined {
  const value = optionalNonBlank(id, 'id');
  return value ? { connect: { id: value } } : undefined;
}

function optionalNote(value: unknown): string | null {
  return optionalNonBlank(value, 'resolutionNote') ?? null;
}

function decimalToString(value: Prisma.Decimal | null | undefined): string | null {
  return value ? value.toString() : null;
}

type GroupCountRow = Record<string, unknown> & { _count?: true | { _all?: number } };

function countBy<T extends GroupCountRow>(rows: T[], field: keyof T, value: string): number {
  const count = rows.find((row) => row[field] === value)?._count;
  return typeof count === 'object' ? count._all ?? 0 : 0;
}

function groupCountMap<T extends GroupCountRow>(rows: T[], field: keyof T): Record<string, number> {
  return Object.fromEntries(
    rows.map((row) => {
      const count = row._count;
      return [String(row[field]), typeof count === 'object' ? count._all ?? 0 : 0];
    }),
  );
}

function sanitizeRawSafeData(value: Prisma.InputJsonValue | null): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  const sanitized = sanitizeJsonValue(value, true);
  if (sanitized === undefined) return undefined;
  if (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) && Object.keys(sanitized).length === 0) {
    return undefined;
  }
  return sanitized as Prisma.InputJsonValue;
}

function sanitizeJsonValue(value: unknown, topLevel: boolean): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => sanitizeJsonValue(item, false)).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (typeof value !== 'object') return undefined;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_PATTERN.test(key)) continue;
    if (topLevel && !RAW_SAFE_KEYS.has(key)) continue;
    const sanitized = sanitizeJsonValue(child, false);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}
