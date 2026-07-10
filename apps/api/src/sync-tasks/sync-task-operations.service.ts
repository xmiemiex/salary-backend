import { Injectable } from '@nestjs/common';
import {
  CommonStatus,
  Prisma,
  Provider,
  SettlementStatus,
  SyncExecutionErrorCategory,
  SyncTaskSourceType,
  SyncTaskStatus,
  SyncTaskTriggerType,
} from '@prisma/client';
import { ERROR_CODES, PermissionCode } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { readSyncAutoExecutionConfig } from './sync-auto-execution-config';

export type SyncTaskOperationsQuery = {
  settlementMonth?: string;
  status?: string;
  sourceType?: string;
  provider?: string;
  triggerType?: string;
  abnormalOnly?: string;
  page?: string;
  pageSize?: string;
};

export type SyncTaskOperationActionInput = {
  reason?: unknown;
};

const ACTIVE_RETRY_STATUSES = [SyncTaskStatus.failed, SyncTaskStatus.retry_wait] as const;
const CANCELABLE_STATUSES = [SyncTaskStatus.pending, SyncTaskStatus.retry_wait, SyncTaskStatus.failed] as const;
const SENSITIVE_KEY_RE = /(api[_-]?key|secret|token|password|authorization|client[_-]?id|merchant[_-]?id|encrypted[_-]?payload|payload|hash)/i;

@Injectable()
export class SyncTaskOperationsService {
  private readonly maxAttempts = readSyncAutoExecutionConfig().maxAttempts;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: SyncTaskOperationsQuery = {}, now = new Date()) {
    const page = parsePositiveInt(query.page, 'page', 1);
    const pageSize = Math.min(parsePositiveInt(query.pageSize, 'pageSize', 20), 100);
    const where = this.buildWhere(query, now);

    const [total, items] = await this.prisma.$transaction([
      this.prisma.syncTask.count({ where }),
      this.prisma.syncTask.findMany({
        where,
        include: {
          affiliateAccount: { select: { id: true, platform: true, accountCode: true, accountName: true, status: true } },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { items: items.map((task) => toOperationDto(task, now, this.maxAttempts)), total, page, pageSize };
  }

  async detail(taskId: string, now = new Date()) {
    const task = await this.prisma.syncTask.findUnique({
      where: { id: taskId },
      include: { affiliateAccount: { select: { id: true, platform: true, accountCode: true, accountName: true, status: true } } },
    });
    if (!task) throw new AppError(ERROR_CODES.NOT_FOUND, 'Sync task not found.');

    const auditLogs = await this.prisma.auditLog.findMany({
      where: { objectType: 'sync_tasks', objectId: task.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, action: true, result: true, failureReason: true, errorMessage: true, createdAt: true, actorUserId: true, afterData: true },
    });

    const dto = toOperationDto(task, now, this.maxAttempts);
    return {
      task: dto,
      retryable: isRetryable(task.lastErrorCategory),
      suggestedAction: suggestedAction(task.lastErrorCategory),
      recentEvents: auditLogs.map((log) => ({
        id: log.id,
        action: log.action,
        result: log.result,
        failureReason: log.failureReason,
        errorMessage: redactText(log.errorMessage),
        createdAt: log.createdAt,
        actorUserId: log.actorUserId,
        summary: sanitizeJson(log.afterData),
      })),
    };
  }

  async requestRetry(taskId: string, input: SyncTaskOperationActionInput, actor: Actor, now = new Date()) {
    const reason = parseReason(input.reason);
    const task = await this.loadTaskOrThrow(taskId);
    this.assertActionPermission(task, actor);

    if (!ACTIVE_RETRY_STATUSES.includes(task.status as (typeof ACTIVE_RETRY_STATUSES)[number])) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Only failed or retry_wait sync tasks can request retry.');
    }
    await this.assertUnlocked(task, actor, 'sync_task.manual_retry_requested');
    await this.assertHasActiveCredential(task);

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.syncTask.updateMany({
        where: { id: task.id, status: { in: [...ACTIVE_RETRY_STATUSES] } },
        data: { status: SyncTaskStatus.pending, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, finishedAt: null, updatedAt: now },
      });
      if (!result.count) return null;
      await this.audit.success({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'sync_task.manual_retry_requested',
        objectType: 'sync_tasks',
        objectId: task.id,
        settlementMonth: task.settlementMonth,
        beforeData: operationAuditData(task),
        afterData: { ...operationAuditData(task), status: SyncTaskStatus.pending, reason },
        changedFields: ['status', 'nextAttemptAt', 'leaseOwner', 'leaseExpiresAt'],
        requestPayload: operationRequestPayload(task, reason),
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      }, tx);
      return tx.syncTask.findUnique({
        where: { id: task.id },
        include: { affiliateAccount: { select: { id: true, platform: true, accountCode: true, accountName: true, status: true } } },
      });
    });

    if (!updated) throw new AppError(ERROR_CODES.CONFLICT, 'Sync task status changed before retry request was applied.');
    return { task: toOperationDto(updated, now, this.maxAttempts), action: 'manual_retry_requested' };
  }

  async cancel(taskId: string, input: SyncTaskOperationActionInput, actor: Actor, now = new Date()) {
    const reason = parseReason(input.reason);
    const task = await this.loadTaskOrThrow(taskId);
    this.assertActionPermission(task, actor);

    if (task.status === SyncTaskStatus.completed || task.status === SyncTaskStatus.cancelled) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Completed or cancelled sync tasks cannot be cancelled.');
    }
    const canCancelRunning = task.status === SyncTaskStatus.running && !!task.leaseExpiresAt && task.leaseExpiresAt <= now;
    if (task.status === SyncTaskStatus.running && !canCancelRunning) {
      await this.audit.failure({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'sync_task.cancel_rejected_running_active_lease',
        objectType: 'sync_tasks',
        objectId: task.id,
        settlementMonth: task.settlementMonth,
        requestPayload: operationRequestPayload(task, reason),
        failureReason: 'RUNNING_ACTIVE_LEASE',
        errorMessage: 'Running sync task has an active lease.',
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
      throw new AppError(ERROR_CODES.CONFLICT, 'Running sync task has an active lease.');
    }
    if (!CANCELABLE_STATUSES.includes(task.status as (typeof CANCELABLE_STATUSES)[number]) && !canCancelRunning) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Sync task cannot be cancelled in its current status.');
    }

    const where: Prisma.SyncTaskWhereInput = canCancelRunning
      ? { id: task.id, status: SyncTaskStatus.running, leaseExpiresAt: { lte: now } }
      : { id: task.id, status: { in: [...CANCELABLE_STATUSES] } };

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.syncTask.updateMany({
        where,
        data: {
          status: SyncTaskStatus.cancelled,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          finishedAt: now,
          message: 'Sync task cancelled by administrator.',
          updatedAt: now,
        },
      });
      if (!result.count) return null;
      await this.audit.success({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'sync_task.cancelled',
        objectType: 'sync_tasks',
        objectId: task.id,
        settlementMonth: task.settlementMonth,
        beforeData: operationAuditData(task),
        afterData: { ...operationAuditData(task), status: SyncTaskStatus.cancelled, reason },
        changedFields: ['status', 'leaseOwner', 'leaseExpiresAt', 'nextAttemptAt', 'finishedAt'],
        requestPayload: operationRequestPayload(task, reason),
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      }, tx);
      return tx.syncTask.findUnique({
        where: { id: task.id },
        include: { affiliateAccount: { select: { id: true, platform: true, accountCode: true, accountName: true, status: true } } },
      });
    });

    if (!updated) throw new AppError(ERROR_CODES.CONFLICT, 'Sync task status changed before cancel was applied.');
    return { task: toOperationDto(updated, now, this.maxAttempts), action: 'cancelled' };
  }

  private buildWhere(query: SyncTaskOperationsQuery, now: Date): Prisma.SyncTaskWhereInput {
    const where: Prisma.SyncTaskWhereInput = {};
    if (query.settlementMonth) where.settlementMonth = parseSettlementMonth(query.settlementMonth, 'settlementMonth');
    if (query.status) where.status = assertEnumValue(SyncTaskStatus, query.status, 'status');
    if (query.sourceType) where.sourceType = assertEnumValue(SyncTaskSourceType, query.sourceType, 'sourceType');
    if (query.provider) where.provider = assertEnumValue(Provider, query.provider, 'provider');
    if (query.triggerType) where.triggerType = assertEnumValue(SyncTaskTriggerType, query.triggerType, 'triggerType');
    if (query.abnormalOnly === 'true') {
      where.OR = [
        { status: SyncTaskStatus.failed },
        { status: SyncTaskStatus.retry_wait },
        { status: SyncTaskStatus.running, leaseExpiresAt: { lte: now } },
      ];
    }
    return where;
  }

  private async loadTaskOrThrow(taskId: string) {
    const task = await this.prisma.syncTask.findUnique({
      where: { id: taskId },
      include: { affiliateAccount: { select: { id: true, platform: true, accountCode: true, accountName: true, status: true } } },
    });
    if (!task) throw new AppError(ERROR_CODES.NOT_FOUND, 'Sync task not found.');
    return task;
  }

  private assertActionPermission(task: { sourceType: SyncTaskSourceType }, actor: Actor) {
    const required: PermissionCode = task.sourceType === SyncTaskSourceType.affiliate_income ? 'income.import' : 'manual_card_spend.manage';
    if (!actor.permissions.includes(required)) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'Permission denied.', {
        requiredPermissions: [required],
        missingPermissions: [required],
      });
    }
  }

  private async assertUnlocked(task: { settlementMonth: Date; id: string }, actor: Actor, action: string) {
    const settlement = await this.prisma.monthlySettlement.findUnique({
      where: { settlementMonth: task.settlementMonth },
      select: { status: true },
    });
    if (settlement?.status !== SettlementStatus.locked) return;
    await this.audit.failure({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'sync_task.retry_rejected_locked_month',
      objectType: 'sync_tasks',
      objectId: task.id,
      settlementMonth: task.settlementMonth,
      requestPayload: { taskId: task.id, action },
      failureReason: SyncExecutionErrorCategory.MONTH_LOCKED,
      errorMessage: 'The settlement month is locked.',
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    throw new AppError(ERROR_CODES.MONTH_LOCKED, 'The settlement month is locked.');
  }

  private async assertHasActiveCredential(task: {
    id: string;
    sourceType: SyncTaskSourceType;
    affiliateAccountId: string | null;
    provider: Provider | null;
    settlementMonth: Date;
  }) {
    if (task.sourceType === SyncTaskSourceType.affiliate_income) {
      if (!task.affiliateAccountId) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'affiliateAccountId is required.');
      const credential = await this.prisma.affiliateAccountCredential.findFirst({
        where: { affiliateAccountId: task.affiliateAccountId, status: CommonStatus.active },
        select: { id: true },
      });
      if (credential) return;
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Active affiliate account credential is required.');
    }
    if (!task.provider) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'provider is required.');
    const credential = await this.prisma.cardProviderCredential.findFirst({
      where: { provider: task.provider, status: CommonStatus.active },
      select: { id: true },
    });
    if (!credential) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Active card provider credential is required.');
  }
}

function parseSettlementMonth(value: unknown, field: string): Date {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is required.`);
  }
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value.trim());
  if (!match) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must use YYYY-MM or YYYY-MM-DD format.`);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must use YYYY-MM or YYYY-MM-DD format.`);
  return new Date(Date.UTC(Number(match[1]), monthIndex, 1, 0, 0, 0, 0));
}

function assertEnumValue<T extends Record<string, string>>(enumObject: T, value: string, field: string): T[keyof T] {
  if (Object.values(enumObject).includes(value)) return value as T[keyof T];
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is invalid.`);
}

function parsePositiveInt(value: string | undefined, field: string, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a positive integer.`);
  return parsed;
}

function parseReason(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'reason must be a string.');
  return value.trim().slice(0, 500) || null;
}

function isRetryable(category?: SyncExecutionErrorCategory | string | null) {
  return ['NETWORK_ERROR', 'TIMEOUT', 'RATE_LIMITED', 'PROVIDER_5XX', 'TEMPORARY_DATABASE_ERROR'].includes(String(category ?? ''));
}

function suggestedAction(category?: SyncExecutionErrorCategory | string | null): string {
  const code = String(category ?? '');
  if (['CREDENTIAL_MISSING', 'CREDENTIAL_INVALID'].includes(code)) return '检查并修复 API 凭证配置后再请求重试。';
  if (code === 'MONTH_LOCKED') return '确认是否需要解锁该结算月，或在下个结算月重建任务。';
  if (['RATE_LIMITED', 'PROVIDER_5XX', 'TIMEOUT', 'NETWORK_ERROR'].includes(code)) return '等待自动重试，或确认服务恢复后人工请求重试。';
  if (['BUSINESS_REJECTED', 'VALIDATION_ERROR'].includes(code)) return '人工核对业务数据和任务配置后再处理。';
  return '查看安全错误摘要并按现有同步规则处理。';
}

function leaseState(task: { status: SyncTaskStatus; leaseExpiresAt: Date | null }, now: Date) {
  if (task.status !== SyncTaskStatus.running || !task.leaseExpiresAt) return 'none';
  return task.leaseExpiresAt > now ? 'active' : 'expired';
}

function toOperationDto(task: {
  id: string;
  sourceType: SyncTaskSourceType;
  taskType: string;
  platform: string;
  affiliateAccountId: string | null;
  provider: Provider | null;
  settlementMonth: Date;
  status: SyncTaskStatus;
  successCount: number;
  failedCount: number;
  message: string | null;
  errorMessage: string | null;
  requestedBy: string | null;
  triggerType: SyncTaskTriggerType | string;
  planningKey: string | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  leaseExpiresAt: Date | null;
  lastAttemptAt: Date | null;
  lastErrorCategory: SyncExecutionErrorCategory | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  resultPayload: Prisma.JsonValue | null;
  affiliateAccount?: { id: string; platform: string; accountCode: string; accountName: string | null; status?: CommonStatus } | null;
}, now: Date, maxAttempts: number) {
  return {
    id: task.id,
    taskId: task.id,
    settlementMonth: task.settlementMonth.toISOString().slice(0, 10),
    sourceType: task.sourceType,
    taskType: task.taskType,
    platform: task.platform,
    provider: task.provider,
    affiliateAccountId: task.affiliateAccountId,
    affiliateAccount: task.affiliateAccount,
    triggerType: task.triggerType,
    status: task.status,
    attemptCount: task.attemptCount,
    maxAttempts,
    lastAttemptAt: task.lastAttemptAt,
    nextAttemptAt: task.nextAttemptAt,
    lastErrorCategory: task.lastErrorCategory,
    lastErrorSafeMessage: redactText(task.errorMessage),
    leaseState: leaseState(task, now),
    executing: task.status === SyncTaskStatus.running && leaseState(task, now) === 'active',
    successCount: task.successCount,
    failedCount: task.failedCount,
    message: redactText(task.message),
    requestedBy: task.requestedBy,
    actorType: task.requestedBy ? 'manual' : 'system',
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    resultSummary: sanitizeJson(task.resultPayload),
  };
}

function operationAuditData(task: {
  id: string;
  settlementMonth: Date;
  sourceType: SyncTaskSourceType;
  taskType: string;
  platform: string;
  provider: Provider | null;
  status: SyncTaskStatus;
  attemptCount: number;
  lastErrorCategory: SyncExecutionErrorCategory | null;
}) {
  return {
    taskId: task.id,
    settlementMonth: task.settlementMonth.toISOString().slice(0, 10),
    sourceType: task.sourceType,
    taskType: task.taskType,
    platform: task.platform,
    provider: task.provider,
    status: task.status,
    attemptCount: task.attemptCount,
    errorCategory: task.lastErrorCategory,
  };
}

function operationRequestPayload(task: Parameters<typeof operationAuditData>[0], reason: string | null) {
  return { ...operationAuditData(task), reason };
}

function redactText(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  return value.replace(/(api[_-]?key|secret|token|password|authorization|client[_-]?id|merchant[_-]?id|encrypted[_-]?payload)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]').slice(0, 1000);
}

function sanitizeJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return SENSITIVE_KEY_RE.test(value) ? '[REDACTED]' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_KEY_RE.test(key))
      .map(([key, nested]) => [key, sanitizeJson(nested, seen)]));
  }
  return null;
}
