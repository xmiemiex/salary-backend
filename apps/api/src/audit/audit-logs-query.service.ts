import { Injectable } from '@nestjs/common';
import { AuditResult, Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuditModule,
  deriveAuditModule,
  sanitizeAuditText,
  sanitizeAuditValue,
  summarizeAuditValue,
  toUserAgentSummary,
} from './audit-sanitizer';

export type AuditLogsQuery = {
  page?: unknown;
  pageSize?: unknown;
  settlementMonth?: unknown;
  action?: unknown;
  objectType?: unknown;
  objectId?: unknown;
  actorUserId?: unknown;
  actorUsername?: unknown;
  actorRole?: unknown;
  result?: unknown;
  module?: unknown;
  failureReason?: unknown;
  requestId?: unknown;
  traceId?: unknown;
  ip?: unknown;
  createdFrom?: unknown;
  createdTo?: unknown;
};

export type AuditLogFilters = Omit<AuditLogsQuery, 'page' | 'pageSize'>;

export type ParsedAuditLogFilters = {
  where: Prisma.AuditLogWhereInput;
  settlementMonth?: Date;
  createdFrom: Date;
  createdTo: Date;
  module?: AuditModule;
  summary: Record<string, string>;
};

const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

const LIST_SELECT = {
  id: true,
  actorUserId: true,
  actorRole: true,
  action: true,
  objectType: true,
  objectId: true,
  settlementMonth: true,
  result: true,
  failureReason: true,
  errorMessage: true,
  changedFields: true,
  ipAddress: true,
  userAgent: true,
  requestPayload: true,
  createdAt: true,
  actor: { select: { username: true } },
} satisfies Prisma.AuditLogSelect;

const DETAIL_SELECT = {
  ...LIST_SELECT,
  beforeData: true,
  afterData: true,
  requestPayload: true,
} satisfies Prisma.AuditLogSelect;

type ListRecord = Prisma.AuditLogGetPayload<{ select: typeof LIST_SELECT }>;
type DetailRecord = Prisma.AuditLogGetPayload<{ select: typeof DETAIL_SELECT }>;

@Injectable()
export class AuditLogsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AuditLogsQuery = {}) {
    const page = parsePositiveInteger(query.page, 'page', 1, Number.MAX_SAFE_INTEGER);
    const pageSize = parsePositiveInteger(query.pageSize, 'pageSize', 20, 100);
    const parsed = parseAuditLogFilters(query);

    const [total, items] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where: parsed.where }),
      this.prisma.auditLog.findMany({
        where: parsed.where,
        select: LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { total, page, pageSize, items: items.map(toListDto) };
  }

  async getById(idInput: string) {
    const id = parseUuid(idInput, 'id');
    const auditLog = await this.prisma.auditLog.findUnique({ where: { id }, select: DETAIL_SELECT });
    if (!auditLog) throw new AppError(ERROR_CODES.NOT_FOUND, 'Audit log not found.');
    return toDetailDto(auditLog);
  }
}

export function parseAuditLogFilters(query: AuditLogFilters = {}): ParsedAuditLogFilters {
  const settlementMonth = query.settlementMonth === undefined ? undefined : parseSettlementMonth(query.settlementMonth);
  const explicitFrom = query.createdFrom === undefined ? undefined : parseIsoInstant(query.createdFrom, 'createdFrom');
  const explicitTo = query.createdTo === undefined ? undefined : parseIsoInstant(query.createdTo, 'createdTo');
  if (explicitFrom && explicitTo && explicitFrom > explicitTo) {
    throw validationError('createdFrom must not be later than createdTo.');
  }

  const now = new Date();
  const createdTo = explicitTo ?? now;
  const createdFrom = explicitFrom ?? new Date(createdTo.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (createdTo.getTime() - createdFrom.getTime() > MAX_RANGE_MS) {
    throw validationError('createdFrom and createdTo must span no more than 90 days.');
  }

  const module = query.module === undefined ? undefined : parseModule(query.module);
  const requestId = optionalNonBlank(query.requestId, 'requestId');
  const traceId = optionalNonBlank(query.traceId, 'traceId');
  const ip = optionalNonBlank(query.ip, 'ip');
  const filters = {
    action: optionalNonBlank(query.action, 'action'),
    objectType: optionalNonBlank(query.objectType, 'objectType'),
    objectId: optionalNonBlank(query.objectId, 'objectId'),
    actorUserId: query.actorUserId === undefined ? undefined : parseUuid(query.actorUserId, 'actorUserId'),
    actorRole: optionalNonBlank(query.actorRole, 'actorRole'),
    result: query.result === undefined ? undefined : parseAuditResult(query.result),
    failureReason: optionalNonBlank(query.failureReason, 'failureReason'),
  };

  const and: Prisma.AuditLogWhereInput[] = [
    { createdAt: { gte: createdFrom, lte: createdTo } },
    compactWhere({ settlementMonth, ...filters, ipAddress: ip ? { contains: ip } : undefined }),
  ];
  const actorUsername = optionalNonBlank(query.actorUsername, 'actorUsername');
  if (actorUsername) and.push({ actor: { username: { contains: actorUsername, mode: 'insensitive' } } });
  if (module) and.push(moduleWhere(module));
  if (requestId) and.push({ requestPayload: { path: ['requestId'], equals: requestId } } as Prisma.AuditLogWhereInput);
  if (traceId) and.push({ requestPayload: { path: ['traceId'], equals: traceId } } as Prisma.AuditLogWhereInput);

  const where: Prisma.AuditLogWhereInput = { AND: and };
  const summary = Object.fromEntries(Object.entries({
    settlementMonth: settlementMonth?.toISOString().slice(0, 10),
    ...filters,
    actorUsername,
    module,
    requestId,
    traceId,
    ip,
    createdFrom: createdFrom.toISOString(),
    createdTo: createdTo.toISOString(),
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return { where, settlementMonth, createdFrom, createdTo, module, summary };
}

function toListDto(record: ListRecord) {
  const beforeAfterSummary = [
    summarizeAuditValue(record.failureReason || record.errorMessage || ''),
    record.changedFields?.length ? `changedFields: ${record.changedFields.join(', ')}` : '',
  ].filter(Boolean).join(' | ');
  return {
    id: record.id,
    createdAt: record.createdAt,
    actorUserId: record.actorUserId,
    actorUsername: record.actor?.username ?? null,
    actorRole: record.actorRole,
    action: record.action,
    module: deriveAuditModule(record.action, record.objectType),
    objectType: record.objectType,
    objectId: record.objectId,
    result: record.result,
    summary: beforeAfterSummary || `${record.action} ${record.objectType}`.trim(),
    ipAddress: record.ipAddress,
    userAgentSummary: toUserAgentSummary(record.userAgent),
    settlementMonth: record.settlementMonth,
    requestId: extractString(record, 'requestId'),
    traceId: extractString(record, 'traceId'),
  };
}

function toDetailDto(record: DetailRecord) {
  const beforeData = sanitizeAuditValue(record.beforeData);
  const afterData = sanitizeAuditValue(record.afterData);
  const requestPayload = sanitizeAuditValue(record.requestPayload);
  return {
    ...toListDto(record),
    failureReason: record.failureReason ? sanitizeAuditText(record.failureReason) : null,
    errorCode: record.failureReason ?? null,
    errorMessage: record.errorMessage ? sanitizeAuditText(record.errorMessage) : null,
    changedFields: record.changedFields ?? [],
    beforeDataSummary: summarizeAuditValue(beforeData),
    afterDataSummary: summarizeAuditValue(afterData),
    requestPayloadSummary: summarizeAuditValue(requestPayload),
    sanitizedRaw: { beforeData, afterData, requestPayload },
    relatedLinks: relatedLinks(record.objectType, record.objectId),
    userAgentSummary: toUserAgentSummary(record.userAgent),
  };
}

function extractString(record: ListRecord, key: 'requestId' | 'traceId'): string | null {
  const payload = sanitizeAuditValue(record.requestPayload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function relatedLinks(objectType: string, objectId: string | null) {
  if (!objectId) return [];
  if (objectType === 'sync_task') return [{ label: '同步任务', path: `/data-sync?taskId=${encodeURIComponent(objectId)}` }];
  if (objectType === 'admin_user' || objectType === 'admin_users') return [{ label: '管理员账号', path: '/admin-users' }];
  if (objectType === 'role' || objectType === 'roles') return [{ label: '角色权限', path: '/roles' }];
  return [];
}

function compactWhere(where: Prisma.AuditLogWhereInput): Prisma.AuditLogWhereInput {
  return Object.fromEntries(Object.entries(where).filter(([, value]) => value !== undefined)) as Prisma.AuditLogWhereInput;
}

function moduleWhere(module: AuditModule): Prisma.AuditLogWhereInput {
  if (module === 'auth') return { action: { startsWith: 'auth.', mode: 'insensitive' } };
  if (module === 'admin_users') return { OR: [{ action: { startsWith: 'admin_user.', mode: 'insensitive' } }, { objectType: { in: ['admin_user', 'admin_users'] } }] };
  if (module === 'roles') return { OR: [{ action: { startsWith: 'role.', mode: 'insensitive' } }, { objectType: { in: ['role', 'roles'] } }] };
  if (module === 'sync_planning') return { action: { contains: 'sync_planning', mode: 'insensitive' } };
  if (module === 'sync_execution') return { OR: [{ action: { contains: 'sync_execution', mode: 'insensitive' } }, { action: { contains: 'auto_execution', mode: 'insensitive' } }] };
  if (module === 'sync_operations') return { OR: [{ action: { contains: 'sync_task.manual_retry_requested', mode: 'insensitive' } }, { action: { contains: 'sync_task.cancelled', mode: 'insensitive' } }] };
  if (module === 'credentials') return { OR: [{ action: { contains: 'credential', mode: 'insensitive' } }, { objectType: { contains: 'credential', mode: 'insensitive' } }] };
  if (module === 'dashboard') return { OR: [{ action: { contains: 'dashboard', mode: 'insensitive' } }, { objectType: { contains: 'dashboard', mode: 'insensitive' } }] };
  return {};
}

function parsePositiveInteger(value: unknown, field: string, defaultValue: number, max: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw validationError(`${field} must be an integer between 1 and ${max}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw validationError(`${field} must be an integer between 1 and ${max}.`);
  return parsed;
}

function parseSettlementMonth(value: unknown): Date {
  if (typeof value !== 'string') throw validationError('settlementMonth must use YYYY-MM or YYYY-MM-01 format.');
  const match = /^(\d{4})-(\d{2})(?:-01)?$/.exec(value);
  if (!match) throw validationError('settlementMonth must use YYYY-MM or YYYY-MM-01 format.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw validationError('settlementMonth must use YYYY-MM or YYYY-MM-01 format.');
  return new Date(Date.UTC(year, month - 1, 1));
}

function parseIsoInstant(value: unknown, field: string): Date {
  if (typeof value !== 'string') throw validationError(`${field} must be an ISO 8601 timestamp with a timezone.`);
  const parsed = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(parsed.getTime())) {
    throw validationError(`${field} must be a valid ISO 8601 timestamp.`);
  }
  return parsed;
}

function parseUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw validationError(`${field} must be a valid UUID.`);
  }
  return value;
}

function parseAuditResult(value: unknown): AuditResult {
  if (value === AuditResult.success || value === AuditResult.failure) return value;
  throw validationError('result must be success or failure.');
}

function parseModule(value: unknown): AuditModule {
  const allowed: AuditModule[] = ['auth', 'admin_users', 'roles', 'sync_planning', 'sync_execution', 'sync_operations', 'dashboard', 'credentials', 'system', 'other'];
  if (typeof value === 'string' && (allowed as string[]).includes(value)) return value as AuditModule;
  throw validationError('module is invalid.');
}

function optionalNonBlank(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw validationError(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) throw validationError(`${field} must not be blank.`);
  return trimmed;
}

function validationError(message: string) {
  return new AppError(ERROR_CODES.VALIDATION_ERROR, message);
}
