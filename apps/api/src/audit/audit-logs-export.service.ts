import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { Actor } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { csvSafeCell, deriveAuditModule, sanitizeAuditText, summarizeAuditValue, toUserAgentSummary } from './audit-sanitizer';
import { AuditLogFilters, parseAuditLogFilters } from './audit-logs-query.service';
import { AuditService } from './audit.service';

export type AuditLogsExportQuery = AuditLogFilters & { page?: unknown; pageSize?: unknown };

const MAX_EXPORT_ROWS = 10_000;
const EXPORT_HEADERS = [
  'id',
  'createdAt',
  'actorUserId',
  'actorUsername',
  'actorRole',
  'action',
  'module',
  'objectType',
  'objectId',
  'result',
  'summary',
  'ipAddress',
  'userAgentSummary',
  'settlementMonth',
  'requestId',
  'traceId',
] as const;

const EXPORT_SELECT = {
  id: true,
  createdAt: true,
  actorUserId: true,
  actorRole: true,
  action: true,
  objectType: true,
  objectId: true,
  result: true,
  failureReason: true,
  errorMessage: true,
  changedFields: true,
  ipAddress: true,
  userAgent: true,
  settlementMonth: true,
  requestPayload: true,
  actor: { select: { username: true } },
} satisfies Prisma.AuditLogSelect;

type ExportRecord = Prisma.AuditLogGetPayload<{ select: typeof EXPORT_SELECT }>;

@Injectable()
export class AuditLogsExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async export(query: AuditLogsExportQuery, actor: Actor) {
    let safeSummary: Record<string, string | number | string[]> = { filterFields: presentFilterFields(query) };
    try {
      if (query.page !== undefined || query.pageSize !== undefined) {
        throw validationError('page and pageSize are not accepted by the audit log export endpoint.');
      }
      const parsed = parseAuditLogFilters(query);
      safeSummary = parsed.summary;

      const records = await this.prisma.auditLog.findMany({
        where: parsed.where,
        select: EXPORT_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_EXPORT_ROWS + 1,
      });
      if (records.length > MAX_EXPORT_ROWS) {
        throw validationError(`Export exceeds ${MAX_EXPORT_ROWS} audit logs; narrow the filter range.`);
      }

      const csv = toAuditLogCsv(records);
      await this.audit.success({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'audit_logs.exported',
        objectType: 'audit_logs',
        settlementMonth: parsed.settlementMonth,
        requestPayload: safeSummary,
        afterData: { exportedCount: records.length },
        changedFields: [],
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });

      return { csv, filename: filenameForRange(parsed.createdFrom, parsed.createdTo), exportedCount: records.length };
    } catch (error) {
      await this.writeFailureAudit(actor, safeSummary, error);
      throw error;
    }
  }

  private async writeFailureAudit(actor: Actor, safeSummary: Record<string, string | number | string[]>, error: unknown) {
    try {
      await this.audit.failure({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'audit_logs.exported',
        objectType: 'audit_logs',
        requestPayload: safeSummary,
        failureReason: error instanceof AppError ? error.code : ERROR_CODES.AUDIT_WRITE_FAILED,
        errorMessage: error instanceof AppError ? error.message : 'Audit log export failed.',
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
    } catch {
      // Avoid recursive audit writes while recording export failures.
    }
  }
}

export function toAuditLogCsv(records: ExportRecord[]): string {
  const rows = records.map((record) => [
    record.id,
    record.createdAt,
    record.actorUserId,
    record.actor?.username ?? '',
    record.actorRole,
    record.action,
    deriveAuditModule(record.action, record.objectType),
    record.objectType,
    record.objectId,
    record.result,
    summarizeRow(record),
    record.ipAddress,
    toUserAgentSummary(record.userAgent),
    record.settlementMonth,
    extractPayloadString(record.requestPayload, 'requestId'),
    extractPayloadString(record.requestPayload, 'traceId'),
  ]);
  return `\uFEFF${[EXPORT_HEADERS, ...rows].map((row) => row.map(csvSafeCell).join(',')).join('\r\n')}`;
}

function summarizeRow(record: ExportRecord): string {
  return sanitizeAuditText([
    record.failureReason || '',
    record.errorMessage || '',
    record.changedFields?.length ? `changedFields: ${record.changedFields.join(', ')}` : '',
  ].filter(Boolean).join(' | ') || `${record.action} ${record.objectType}`.trim(), 300);
}

function extractPayloadString(value: Prisma.JsonValue | null, key: 'requestId' | 'traceId'): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const result = (value as Record<string, unknown>)[key];
  return typeof result === 'string' ? sanitizeAuditText(result, 120) : '';
}

function filenameForRange(createdFrom: Date, createdTo: Date): string {
  return `audit-logs-${createdFrom.toISOString().slice(0, 10)}_${createdTo.toISOString().slice(0, 10)}.csv`;
}

function presentFilterFields(query: AuditLogsExportQuery): string[] {
  const allowed = ['settlementMonth', 'action', 'objectType', 'objectId', 'actorUserId', 'actorUsername', 'actorRole', 'result', 'failureReason', 'module', 'requestId', 'traceId', 'ip', 'createdFrom', 'createdTo'];
  return allowed.filter((field) => query[field as keyof AuditLogsExportQuery] !== undefined);
}

function validationError(message: string) {
  return new AppError(ERROR_CODES.VALIDATION_ERROR, message);
}
