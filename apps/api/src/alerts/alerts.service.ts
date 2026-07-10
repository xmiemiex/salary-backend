import { Inject, Injectable } from '@nestjs/common';
import {
  AlertSeverity,
  AlertStatus,
  CommonStatus,
  Prisma,
  SyncExecutionErrorCategory,
  SyncTaskStatus,
  SyncTaskTriggerType,
} from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { SystemHealthService } from '../system-health/system-health.service';
import { SystemHealthCheck } from '../system-health/system-health.types';
import { readSyncAutoExecutionConfig } from '../sync-tasks/sync-auto-execution-config';
import { BackupHealthService } from '../backup-recovery/backup-health.service';
import { sanitizeAlertDetails, sanitizeAlertText } from './alert-sanitizer';
import { NotificationsService } from './notifications.service';

type Candidate = {
  fingerprint: string;
  severity: AlertSeverity;
  source: string;
  category: string;
  title: string;
  safeMessage: string;
  safeDetails?: unknown;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly systemHealth: SystemHealthService,
    @Inject(BackupHealthService)
    backupHealthOrNotifications: BackupHealthService | NotificationsService,
    notifications?: NotificationsService,
  ) {
    if (notifications) {
      this.backupHealth = backupHealthOrNotifications as BackupHealthService;
      this.notifications = notifications;
    } else {
      this.backupHealth = { alertCandidates: async () => [] } as unknown as BackupHealthService;
      this.notifications = backupHealthOrNotifications as NotificationsService;
    }
  }

  private readonly backupHealth: BackupHealthService;
  private readonly notifications: NotificationsService;

  async list(query: Record<string, unknown> = {}) {
    const page = positiveInt(query.page, 1, 100000);
    const pageSize = positiveInt(query.pageSize, 20, 100);
    const where: Prisma.AlertWhereInput = {
      status: enumValue(query.status, AlertStatus),
      severity: enumValue(query.severity, AlertSeverity),
      source: optionalText(query.source, 64),
      category: optionalText(query.category, 64),
      createdAt: dateRange(query.createdAtFrom, query.createdAtTo),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.alert.count({ where }),
      this.prisma.alert.findMany({
        where,
        orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, items: items.map(alertDto) };
  }

  async get(idInput: string) {
    const alert = await this.prisma.alert.findUnique({ where: { id: uuid(idInput) } });
    if (!alert) throw new AppError(ERROR_CODES.NOT_FOUND, 'Alert not found.');
    return alertDto(alert);
  }

  async scan(actor: Actor) {
    const now = new Date();
    try {
      const candidates = await this.buildCandidates(now);
      const seen = new Set(candidates.map((candidate) => candidate.fingerprint));
      let generated = 0;
      let reactivated = 0;
      let updated = 0;
      let resolved = 0;
      let notificationsCreated = 0;

      await this.prisma.$transaction(async (tx) => {
        for (const candidate of candidates) {
          const existing = await tx.alert.findUnique({ where: { fingerprint: candidate.fingerprint } });
          const nextStatus = existing?.status === AlertStatus.silenced && existing.silencedUntil && existing.silencedUntil > now
            ? AlertStatus.silenced
            : AlertStatus.active;
          const safeDetails = jsonInput(candidate.safeDetails);
          if (!existing) {
            const created = await tx.alert.upsert({
              where: { fingerprint: candidate.fingerprint },
              create: {
                fingerprint: candidate.fingerprint,
                severity: candidate.severity,
                status: nextStatus,
                source: candidate.source,
                category: candidate.category,
                title: sanitizeAlertText(candidate.title, 255),
                safeMessage: sanitizeAlertText(candidate.safeMessage, 1000),
                safeDetails,
                firstSeenAt: now,
                lastSeenAt: now,
              },
              update: {
                severity: candidate.severity,
                status: nextStatus,
                source: candidate.source,
                category: candidate.category,
                title: sanitizeAlertText(candidate.title, 255),
                safeMessage: sanitizeAlertText(candidate.safeMessage, 1000),
                safeDetails,
                lastSeenAt: now,
                resolvedAt: null,
                ...(nextStatus === AlertStatus.active ? { silencedUntil: null } : {}),
              },
            });
            generated += 1;
            await this.writeAlertAudit(tx, 'alert.generated', actor, created, { fromStatus: null, toStatus: created.status, reason: 'scan_detected' });
            notificationsCreated += await this.notifications.notifySuperAdmins(notificationInput(created), tx);
            continue;
          }

          const wasResolved = existing.status === AlertStatus.resolved;
          const next = await tx.alert.update({
            where: { id: existing.id },
            data: {
              severity: candidate.severity,
              status: nextStatus,
              source: candidate.source,
              category: candidate.category,
              title: sanitizeAlertText(candidate.title, 255),
              safeMessage: sanitizeAlertText(candidate.safeMessage, 1000),
              safeDetails,
              lastSeenAt: now,
              resolvedAt: null,
              ...(nextStatus === AlertStatus.active ? { silencedUntil: null } : {}),
            },
          });
          if (wasResolved) {
            reactivated += 1;
            await this.writeAlertAudit(tx, 'alert.generated', actor, next, { fromStatus: AlertStatus.resolved, toStatus: next.status, reason: 'scan_reactivated' });
            notificationsCreated += await this.notifications.notifySuperAdmins(notificationInput(next), tx);
          } else {
            updated += 1;
          }
        }

        const activeAlerts = await tx.alert.findMany({
          where: { status: { in: [AlertStatus.active, AlertStatus.silenced] } },
        });
        for (const alert of activeAlerts) {
          if (seen.has(alert.fingerprint)) continue;
          const next = await tx.alert.update({
            where: { id: alert.id },
            data: { status: AlertStatus.resolved, resolvedAt: now, lastSeenAt: now },
          });
          resolved += 1;
          await this.writeAlertAudit(tx, 'alert.resolved', actor, next, { fromStatus: alert.status, toStatus: AlertStatus.resolved, reason: 'scan_not_detected' });
        }

        await this.audit.success({
          actorUserId: actor.userId,
          actorRole: actor.roleCode,
          action: 'alert.scan_completed',
          objectType: 'alert',
          requestPayload: { generated, reactivated, updated, resolved, notificationsCreated, count: candidates.length, timestamp: now.toISOString() },
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        }, tx);
      });

      return { generated, reactivated, updated, resolved, notificationsCreated, scannedAt: now.toISOString() };
    } catch (error) {
      await this.audit.failure({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'alert.scan_failed',
        objectType: 'alert',
        requestPayload: { reason: 'scan_failed', timestamp: now.toISOString() },
        failureReason: 'ALERT_SCAN_FAILED',
        errorMessage: error instanceof AppError ? error.message : 'Alert scan failed.',
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(ERROR_CODES.CONFLICT, 'Alert scan failed.');
    }
  }

  async acknowledge(idInput: string, actor: Actor) {
    const id = uuid(idInput);
    const now = new Date();
    const before = await this.prisma.alert.findUnique({ where: { id } });
    if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, 'Alert not found.');
    const alert = await this.prisma.alert.update({ where: { id }, data: { acknowledgedAt: now, acknowledgedBy: actor.userId } });
    await this.writeAlertAudit(this.prisma, 'alert.acknowledged', actor, alert, { fromStatus: before.status, toStatus: alert.status, reason: 'manual_acknowledge' });
    return alertDto(alert);
  }

  async silence(idInput: string, body: Record<string, unknown>, actor: Actor) {
    const id = uuid(idInput);
    const minutes = positiveInt(body.minutes, 60, 10080);
    const now = new Date();
    const until = new Date(now.getTime() + minutes * 60 * 1000);
    const before = await this.prisma.alert.findUnique({ where: { id } });
    if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, 'Alert not found.');
    const alert = await this.prisma.alert.update({
      where: { id },
      data: { status: AlertStatus.silenced, silencedUntil: until },
    });
    await this.writeAlertAudit(this.prisma, 'alert.silenced', actor, alert, { fromStatus: before.status, toStatus: AlertStatus.silenced, reason: 'manual_silence', silencedUntil: until.toISOString() });
    return alertDto(alert);
  }

  private async buildCandidates(now: Date): Promise<Candidate[]> {
    const [health, backupCandidates, syncTaskCandidates, credentialCandidates] = await Promise.all([
      this.systemHealth.getSystemHealth(now),
      this.backupHealth.alertCandidates(now),
      this.syncTaskCandidates(now),
      this.credentialCandidates(),
    ]);
    const healthCandidates = health.checks
      .filter((item) => item.status === 'warning' || item.status === 'critical')
      .map((item) => fromHealthCheck(item));
    return dedupe([...healthCandidates, ...backupCandidates, ...syncTaskCandidates, ...credentialCandidates]);
  }

  private async syncTaskCandidates(now: Date): Promise<Candidate[]> {
    const config = readSyncAutoExecutionConfig();
    const retryThreshold = new Date(now.getTime() - Math.max(config.retryBaseSeconds * 4, 900) * 1000);
    const tasks = await this.prisma.syncTask.findMany({
      where: {
        OR: [
          { status: SyncTaskStatus.failed, triggerType: SyncTaskTriggerType.scheduled },
          { status: SyncTaskStatus.retry_wait, nextAttemptAt: { lt: retryThreshold } },
          { status: SyncTaskStatus.running, leaseExpiresAt: { lte: now } },
          { attemptCount: { gte: config.maxAttempts }, status: { in: [SyncTaskStatus.failed, SyncTaskStatus.retry_wait] } },
          { lastErrorCategory: SyncExecutionErrorCategory.MONTH_LOCKED },
          { lastErrorCategory: SyncExecutionErrorCategory.CREDENTIAL_INVALID },
        ],
      },
      take: 100,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        status: true,
        platform: true,
        provider: true,
        taskType: true,
        settlementMonth: true,
        attemptCount: true,
        lastErrorCategory: true,
        nextAttemptAt: true,
        leaseExpiresAt: true,
      },
    });
    return tasks.map((task) => ({
      fingerprint: `sync-task:${task.id}:${task.status}:${task.lastErrorCategory ?? 'none'}`,
      severity: task.status === SyncTaskStatus.running || task.status === SyncTaskStatus.failed ? AlertSeverity.critical : AlertSeverity.warning,
      source: 'sync_task',
      category: task.lastErrorCategory === SyncExecutionErrorCategory.MONTH_LOCKED ? 'month_lock' : 'sync_execution',
      title: task.status === SyncTaskStatus.running ? '同步任务运行租约过期' : '同步任务异常',
      safeMessage: `同步任务 ${task.taskType} 当前状态为 ${task.status}。`,
      safeDetails: {
        taskId: task.id,
        status: task.status,
        platform: task.platform,
        provider: task.provider,
        taskType: task.taskType,
        settlementMonth: task.settlementMonth.toISOString().slice(0, 10),
        attemptCount: task.attemptCount,
        lastErrorCategory: task.lastErrorCategory,
        nextAttemptAt: task.nextAttemptAt,
        leaseExpiresAt: task.leaseExpiresAt,
      },
    }));
  }

  private async credentialCandidates(): Promise<Candidate[]> {
    const [affiliateMissing, cardMissing] = await Promise.all([
      this.prisma.affiliateAccount.count({ where: { status: CommonStatus.active, credential: null } }),
      this.prisma.cardProviderCredential.count({ where: { status: CommonStatus.active } }),
    ]);
    const candidates: Candidate[] = [];
    if (affiliateMissing > 0) {
      candidates.push({
        fingerprint: 'credentials:affiliate:missing-active',
        severity: AlertSeverity.warning,
        source: 'credentials',
        category: 'missing_credentials',
        title: '联盟账号缺少有效凭证',
        safeMessage: '存在 active 联盟账号未配置 active 凭证。',
        safeDetails: { missingActiveAffiliateCredentialCount: affiliateMissing },
      });
    }
    if (cardMissing < 2) {
      candidates.push({
        fingerprint: 'credentials:card-provider:missing-active',
        severity: AlertSeverity.warning,
        source: 'credentials',
        category: 'missing_credentials',
        title: '虚拟卡 provider 缺少有效凭证',
        safeMessage: 'Airwallex 或 PhotonPay 缺少 active 凭证。',
        safeDetails: { activeCardProviderCredentialCount: cardMissing },
      });
    }
    return candidates;
  }

  private async writeAlertAudit(
    prisma: PrismaService | Prisma.TransactionClient,
    action: string,
    actor: Actor,
    alert: ReturnType<typeof alertDto> | Prisma.AlertGetPayload<Record<string, never>>,
    extra: Record<string, unknown>,
  ) {
    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action,
      objectType: 'alert',
      objectId: alert.id,
      requestPayload: {
        alertId: alert.id,
        fingerprint: alert.fingerprint,
        severity: alert.severity,
        source: alert.source,
        category: alert.category,
        timestamp: new Date().toISOString(),
        ...extra,
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    }, prisma);
  }
}

function fromHealthCheck(item: SystemHealthCheck): Candidate {
  return {
    fingerprint: `system-health:${item.code}`,
    severity: item.status === 'critical' ? AlertSeverity.critical : AlertSeverity.warning,
    source: 'system_health',
    category: item.code.toLowerCase().includes('credential') ? 'credentials'
      : item.code.toLowerCase().includes('audit') ? 'audit'
      : item.code.toLowerCase().includes('lock') ? 'month_lock'
      : item.code.toLowerCase().includes('sync') ? 'sync'
      : 'health_check',
    title: item.title,
    safeMessage: item.message,
    safeDetails: { code: item.code, remediation: item.remediation, ...((item.safeDetails ?? {}) as Record<string, unknown>) },
  };
}

function alertDto(alert: {
  id: string;
  fingerprint: string;
  severity: AlertSeverity;
  status: AlertStatus;
  source: string;
  category: string;
  title: string;
  safeMessage: string;
  safeDetails: Prisma.JsonValue | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  silencedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: alert.id,
    fingerprint: alert.fingerprint,
    severity: alert.severity,
    status: alert.status,
    source: alert.source,
    category: alert.category,
    title: sanitizeAlertText(alert.title, 255),
    safeMessage: sanitizeAlertText(alert.safeMessage, 1000),
    safeDetails: sanitizeAlertDetails(alert.safeDetails),
    firstSeenAt: alert.firstSeenAt,
    lastSeenAt: alert.lastSeenAt,
    resolvedAt: alert.resolvedAt,
    acknowledgedAt: alert.acknowledgedAt,
    acknowledgedBy: alert.acknowledgedBy,
    silencedUntil: alert.silencedUntil,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt,
  };
}

function notificationInput(alert: ReturnType<typeof alertDto>) {
  return {
    alertId: alert.id,
    type: 'alert.generated',
    severity: alert.severity,
    title: alert.title,
    safeMessage: alert.safeMessage,
    safeDetails: { alertId: alert.id, fingerprint: alert.fingerprint, source: alert.source, category: alert.category },
  };
}

function dedupe(candidates: Candidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.fingerprint)) return false;
    seen.add(candidate.fingerprint);
    return true;
  });
}

function uuid(value: unknown) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'id must be a valid UUID.');
  return value;
}

function positiveInt(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max) return value;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'value must be a positive integer.');
  const parsed = Number(value);
  if (parsed < 1 || parsed > max) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'value is out of range.');
  return parsed;
}

function optionalText(value: unknown, max: number) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'filter is invalid.');
  return sanitizeAlertText(value, max);
}

function enumValue<T extends Record<string, string>>(value: unknown, enumObject: T): T[keyof T] | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'string' && Object.values(enumObject).includes(value)) return value as T[keyof T];
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'enum filter is invalid.');
}

function dateRange(from: unknown, to: unknown): Prisma.DateTimeFilter | undefined {
  const gte = parseDate(from);
  const lte = parseDate(to);
  if (!gte && !lte) return undefined;
  return { gte, lte };
}

function parseDate(value: unknown) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'date filter is invalid.');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'date filter is invalid.');
  return date;
}

function jsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  const sanitized = sanitizeAlertDetails(value);
  return sanitized === null ? undefined : sanitized;
}
