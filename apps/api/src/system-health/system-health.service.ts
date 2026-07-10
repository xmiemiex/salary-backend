import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  AuditResult,
  CommonStatus,
  Provider,
  SettlementStatus,
  SyncExecutionErrorCategory,
  SyncPlanningRunStatus,
  SyncTaskStatus,
  SyncTaskTriggerType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BackupHealthService } from '../backup-recovery/backup-health.service';
import { getCurrentSettlementMonth, formatSettlementMonth } from '../settlement/settlement-month.util';
import { getPreviousGmt8Month, isPlannerDue, monthText, readSyncPlannerConfig } from '../sync-tasks/sync-planner-config';
import { readSyncAutoExecutionConfig } from '../sync-tasks/sync-auto-execution-config';
import { safeSystemHealthText, sanitizeSystemHealthValue } from './system-health-sanitizer';
import { SystemHealthCheck, SystemHealthResponse, SystemHealthStatus } from './system-health.types';

const CRITICAL_TABLES = ['admin_users', 'roles', 'audit_logs', 'sync_tasks', 'monthly_settlements'] as const;
const CARD_PROVIDERS = [Provider.airwallex, Provider.photonpay] as const;
const AFFILIATE_PLATFORMS = ['everflow', 'cake'] as const;
const QUERY_WINDOW_24H_MS = 24 * 60 * 60 * 1000;

type SectionResult<T extends Record<string, unknown>> = {
  data: T;
  checks: SystemHealthCheck[];
};

@Injectable()
export class SystemHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly backupHealth: BackupHealthService = ({
      getHealth: async () => ({
        latestBackup: null,
        latestSuccessfulBackup: null,
        latestRestoreDrill: null,
        latestSuccessfulRestoreDrill: null,
        daysSinceLastSuccessBackup: null,
        daysSinceLastSuccessDrill: null,
        status: 'ok',
        checks: [],
      }),
    } as unknown as BackupHealthService),
  ) {}

  async getSystemHealth(now = new Date()): Promise<SystemHealthResponse> {
    const sections = await Promise.all([
      this.safeSection('environment', () => this.readEnvironment(now)),
      this.safeSection('database', () => this.readDatabase(now)),
      this.safeSection('syncPlanning', () => this.readSyncPlanning(now)),
      this.safeSection('autoExecution', () => this.readAutoExecution(now)),
      this.safeSection('credentials', () => this.readCredentials(now)),
      this.safeSection('settlements', () => this.readSettlements(now)),
      this.safeSection('dataProtection', () => this.readDataProtection(now)),
      this.safeSection('recentIncidents', () => this.readRecentIncidents(now)),
      this.safeSection('audit', () => this.readAudit(now)),
      this.safeSection('e2e', () => this.readE2e(now)),
    ] as const);

    const [
      environment,
      database,
      syncPlanning,
      autoExecution,
      credentials,
      settlements,
      dataProtection,
      recentIncidents,
      audit,
      e2e,
    ] = sections;
    const checks = sections.flatMap((section) => section.checks);
    const response: SystemHealthResponse = {
      status: aggregateStatus(checks),
      generatedAt: now.toISOString(),
      environment: environment.data,
      database: database.data,
      syncPlanning: syncPlanning.data,
      autoExecution: autoExecution.data,
      credentials: credentials.data,
      settlements: settlements.data,
      dataProtection: dataProtection.data,
      recentIncidents: Array.isArray(recentIncidents.data.items) ? recentIncidents.data.items as Array<Record<string, unknown>> : [],
      audit: audit.data,
      e2e: e2e.data,
      checks,
    };
    return sanitizeSystemHealthValue(response);
  }

  private async safeSection<T extends Record<string, unknown>>(
    code: string,
    load: () => Promise<SectionResult<T>>,
  ): Promise<SectionResult<T>> {
    try {
      return await load();
    } catch (error) {
      return {
        data: { status: 'critical', error: 'CHECK_FAILED' } as unknown as T,
        checks: [check(`${code.toUpperCase()}_CHECK_FAILED`, 'critical', `${code} 检查失败`, '该分区查询失败，已隐藏内部错误。', {}, '查看服务日志和数据库连通性。')],
      };
    }
  }

  private async readEnvironment(now: Date): Promise<SectionResult<Record<string, unknown>>> {
    const packageVersion = readPackageVersion();
    const ports = {
      api: parsePort(process.env.API_PORT, 3000),
      web: parsePort(process.env.WEB_PORT, 5173),
      postgres: parsePort(process.env.POSTGRES_PORT, 5432),
    };
    const configChecks: SystemHealthCheck[] = [];
    let plannerConfig: Record<string, unknown> = { readable: false };
    let autoConfig: Record<string, unknown> = { readable: false };
    try {
      const config = readSyncPlannerConfig();
      plannerConfig = { enabled: config.enabled, day: config.day, hour: config.hour, timezone: config.timezone };
      configChecks.push(check('SYNC_PLANNER_CONFIG_READABLE', 'ok', '同步规划配置可读取', '同步规划配置通过启动期校验。'));
    } catch {
      configChecks.push(check('SYNC_PLANNER_CONFIG_READABLE', 'critical', '同步规划配置不可读取', '同步规划环境配置不合法。', {}, '修正同步规划环境配置后重启服务。'));
    }
    try {
      const config = readSyncAutoExecutionConfig();
      autoConfig = {
        enabled: config.enabled,
        pollSeconds: config.pollSeconds,
        batchSize: config.batchSize,
        maxAttempts: config.maxAttempts,
        leaseSeconds: config.leaseSeconds,
        retryBaseSeconds: config.retryBaseSeconds,
      };
      configChecks.push(check('SYNC_AUTO_EXECUTION_CONFIG_READABLE', 'ok', '自动执行配置可读取', '自动执行配置通过启动期校验。'));
    } catch {
      configChecks.push(check('SYNC_AUTO_EXECUTION_CONFIG_READABLE', 'critical', '自动执行配置不可读取', '自动执行环境配置不合法。', {}, '修正自动执行环境配置后重启服务。'));
    }

    return {
      data: {
        nodeEnv: process.env.NODE_ENV ?? 'development',
        appEnv: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
        packageVersion,
        buildTimestamp: process.env.BUILD_TIMESTAMP ?? null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        serverTime: now.toISOString(),
        configuredPorts: ports,
        featureFlags: { syncPlanning: plannerConfig, syncAutoExecution: autoConfig },
      },
      checks: [
        check('ENVIRONMENT_READABLE', 'ok', '环境摘要可读取', '环境与版本信息已按白名单返回。'),
        ...configChecks,
      ],
    };
  }

  private async readDatabase(now: Date): Promise<SectionResult<Record<string, unknown>>> {
    const checks: SystemHealthCheck[] = [];
    const started = Date.now();
    let connected = false;
    let databaseTime: Date | null = null;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
      databaseTime = rows[0]?.now ? new Date(rows[0].now) : null;
      connected = true;
      checks.push(check('DATABASE_CONNECTED', 'ok', '数据库连接正常', 'Prisma 可以执行轻量查询。'));
    } catch {
      checks.push(check('DATABASE_CONNECTED', 'critical', '数据库连接失败', 'Prisma 轻量查询失败。', {}, '检查数据库服务、网络和迁移状态。'));
    }

    const tableAccess: Record<string, string> = {};
    if (connected) {
      for (const table of CRITICAL_TABLES) {
        try {
          await this.prisma.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`);
          tableAccess[table] = 'ok';
        } catch {
          tableAccess[table] = 'critical';
          checks.push(check(`TABLE_${table.toUpperCase()}_ACCESSIBLE`, 'critical', `${table} 表不可访问`, '关键表轻量查询失败。', { table }, '检查 schema 和迁移是否完整。'));
        }
      }
    }

    const migration = connected ? await this.safeMigrationStatus() : { checked: false, reason: 'DATABASE_UNAVAILABLE' };
    const dbTimeSkewMs = databaseTime ? Math.abs(databaseTime.getTime() - now.getTime()) : null;
    checks.push(check('MIGRATION_STATUS_SAFE', migration.checked ? 'ok' : 'warning', '迁移状态安全读取', migration.checked ? '已读取最近已执行 migration。' : '未执行 CLI migration 状态检查。', migration));
    if (dbTimeSkewMs !== null) {
      checks.push(check('DATABASE_TIME_SKEW', dbTimeSkewMs > 60_000 ? 'warning' : 'ok', '数据库时间差', `数据库与 API 时间差 ${dbTimeSkewMs}ms。`, { skewMs: dbTimeSkewMs }, '若持续超过 60 秒，检查服务器时间同步。'));
    }

    return {
      data: {
        connected,
        queryLatencyMs: Date.now() - started,
        schemaAccessible: connected && Object.values(tableAccess).every((status) => status === 'ok'),
        prismaQueryable: connected,
        databaseTime: databaseTime?.toISOString() ?? null,
        apiTime: now.toISOString(),
        dbTimeSkewMs,
        criticalTables: tableAccess,
        migrations: migration,
        dbErrorsLast24h: await this.countAuditFailures(now, ['TEMPORARY_DATABASE_ERROR', 'DATABASE_ERROR']),
      },
      checks,
    };
  }

  private async safeMigrationStatus() {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
        SELECT migration_name, finished_at, rolled_back_at
        FROM "_prisma_migrations"
        ORDER BY finished_at DESC NULLS LAST, started_at DESC
        LIMIT 1
      `;
      const latest = rows[0] ?? null;
      return {
        checked: true,
        latestMigrationName: latest?.migration_name ?? null,
        latestFinishedAt: latest?.finished_at?.toISOString?.() ?? latest?.finished_at ?? null,
        hasRolledBackLatest: Boolean(latest?.rolled_back_at),
        pendingMigrations: 'not_checked_cli_required',
        drift: 'not_checked_cli_required',
      };
    } catch {
      return { checked: false, reason: 'MIGRATION_TABLE_UNAVAILABLE', pendingMigrations: 'not_checked_cli_required', drift: 'not_checked_cli_required' };
    }
  }

  private async readSyncPlanning(now: Date): Promise<SectionResult<Record<string, unknown>>> {
    const config = readSyncPlannerConfig();
    const targetMonth = getPreviousGmt8Month(now);
    const latest = await this.prisma.syncPlanningRun.findFirst({ orderBy: { lastAttemptAt: 'desc' } });
    const targetRun = await this.prisma.syncPlanningRun.findUnique({ where: { settlementMonth: targetMonth } });
    const lockedSkips = await this.prisma.syncPlanningRun.count({ where: { blockerCodes: { has: 'MONTH_LOCKED' } } });
    const checks = [
      check('SYNC_PLANNER_ENABLED_STATE', 'ok', '同步规划开关', config.enabled ? '同步规划已启用。' : '同步规划未启用。', { enabled: config.enabled }),
      check('SYNC_PLANNER_RECENT_RUN', latest ? (latest.status === SyncPlanningRunStatus.failed ? 'warning' : 'ok') : 'ok', '最近规划执行', latest ? `最近规划状态为 ${latest.status}。` : '尚无持久化规划执行记录。'),
    ];
    if (config.enabled && isPlannerDue(config, now) && !targetRun) {
      checks.push(check('SYNC_PLANNER_DUE_NOT_RUN', 'warning', '当月应规划但未规划', '当前目标月份尚无规划记录。', { currentTargetMonth: monthText(targetMonth) }, '确认 scheduler 是否运行，必要时由有权限管理员手动规划。'));
    }
    return {
      data: {
        enabled: config.enabled,
        configuredDay: config.day,
        configuredHour: config.hour,
        timezone: config.timezone,
        currentTargetMonth: monthText(targetMonth),
        due: isPlannerDue(config, now),
        lastAttemptAt: latest?.lastAttemptAt ?? null,
        lastSuccessAt: latest?.lastSuccessAt ?? null,
        lastFailureAt: latest?.status === SyncPlanningRunStatus.failed ? latest.lastAttemptAt : null,
        lastBlockedCount: latest?.blockedCount ?? 0,
        lockedSkipCount: lockedSkips,
        targetMonthPlanned: Boolean(targetRun),
        lastResult: latest ? {
          status: latest.status,
          settlementMonth: monthText(latest.settlementMonth),
          createdCount: latest.createdCount,
          existingCount: latest.existingCount,
          blockedCount: latest.blockedCount,
          blockerCodes: latest.blockerCodes,
          failureCode: latest.failureCode,
        } : null,
      },
      checks,
    };
  }

  private async readAutoExecution(now: Date): Promise<SectionResult<Record<string, unknown>>> {
    const config = readSyncAutoExecutionConfig();
    const [counts] = await this.prisma.$queryRaw<Array<{
      pending: bigint;
      running: bigint;
      retry_wait: bigint;
      failed: bigint;
      expired: bigint;
      manual_protected: bigint;
    }>>`
      SELECT
        COUNT(*) FILTER (WHERE t.trigger_type = 'scheduled' AND t.planning_key IS NOT NULL AND t.status = 'pending'
          AND t.attempt_count < ${config.maxAttempts}
          AND NOT EXISTS (SELECT 1 FROM monthly_settlements ms WHERE ms.settlement_month = t.settlement_month AND ms.status = 'locked')) AS pending,
        COUNT(*) FILTER (WHERE t.trigger_type = 'scheduled' AND t.status = 'running') AS running,
        COUNT(*) FILTER (WHERE t.trigger_type = 'scheduled' AND t.status = 'retry_wait') AS retry_wait,
        COUNT(*) FILTER (WHERE t.trigger_type = 'scheduled' AND t.status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE t.trigger_type = 'scheduled' AND t.status = 'running' AND t.lease_expires_at <= ${now}) AS expired,
        COUNT(*) FILTER (WHERE t.trigger_type = 'manual' AND t.status IN ('pending', 'retry_wait', 'failed')) AS manual_protected
      FROM sync_tasks t
    `;
    const [latestCompleted, latestFailed, categoryRows] = await Promise.all([
      this.prisma.syncTask.findFirst({ where: { status: SyncTaskStatus.completed }, orderBy: [{ finishedAt: 'desc' }, { updatedAt: 'desc' }], select: { finishedAt: true, updatedAt: true, platform: true, provider: true } }),
      this.prisma.syncTask.findFirst({ where: { status: SyncTaskStatus.failed }, orderBy: [{ finishedAt: 'desc' }, { updatedAt: 'desc' }], select: { finishedAt: true, updatedAt: true, lastErrorCategory: true, platform: true, provider: true } }),
      this.prisma.syncTask.groupBy({ by: ['lastErrorCategory'], where: { lastErrorCategory: { not: null }, updatedAt: { gte: since(now) } }, _count: true }),
    ]);
    const expired = Number(counts?.expired ?? 0);
    const failed = Number(counts?.failed ?? 0);
    return {
      data: {
        enabled: config.enabled,
        pollSeconds: config.pollSeconds,
        batchSize: config.batchSize,
        maxAttempts: config.maxAttempts,
        leaseSeconds: config.leaseSeconds,
        retryBaseSeconds: config.retryBaseSeconds,
        pendingEligibleCount: Number(counts?.pending ?? 0),
        runningCount: Number(counts?.running ?? 0),
        retryWaitingCount: Number(counts?.retry_wait ?? 0),
        failedCount: failed,
        expiredRunningLeaseCount: expired,
        manualTaskProtection: { protectedEligibleCount: Number(counts?.manual_protected ?? 0), autoClaimsManualTasks: false },
        latestCompleted: latestCompleted ? { at: latestCompleted.finishedAt ?? latestCompleted.updatedAt, platform: latestCompleted.platform, provider: latestCompleted.provider } : null,
        latestFailed: latestFailed ? { at: latestFailed.finishedAt ?? latestFailed.updatedAt, category: latestFailed.lastErrorCategory, platform: latestFailed.platform, provider: latestFailed.provider } : null,
        providerErrorCategoryLast24h: Object.fromEntries(categoryRows.map((row) => [row.lastErrorCategory ?? 'unknown', row._count])),
      },
      checks: [
        check('SYNC_AUTO_EXECUTION_ENABLED_STATE', 'ok', '自动执行开关', config.enabled ? '自动执行已启用。' : '自动执行未启用。'),
        check('SYNC_AUTO_EXECUTION_EXPIRED_LEASES', expired > 0 ? 'critical' : 'ok', '过期运行租约', expired > 0 ? '存在过期 running 租约。' : '未发现过期 running 租约。', { expiredRunningLeaseCount: expired }, '检查 worker 是否异常退出。'),
        check('SYNC_AUTO_EXECUTION_FAILED_TASKS', failed > 0 ? 'warning' : 'ok', '自动执行失败任务', failed > 0 ? '存在最终失败的 scheduled 同步任务。' : '未发现最终失败 scheduled 同步任务。', { failedCount: failed }),
        check('MANUAL_TASK_AUTO_EXECUTION_PROTECTED', 'ok', '手动任务自动执行保护', 'manual 任务不会被自动执行聚合为 eligible。'),
      ],
    };
  }

  private async readCredentials(now: Date): Promise<SectionResult<Record<string, unknown>>> {
    const [affiliateAccounts, cardCredentials, recentChanges] = await Promise.all([
      this.prisma.affiliateAccount.findMany({
        where: { platform: { in: [...AFFILIATE_PLATFORMS], mode: 'insensitive' } },
        select: { platform: true, status: true, credential: { select: { status: true, updatedAt: true } } },
      }),
      this.prisma.cardProviderCredential.findMany({ where: { provider: { in: [...CARD_PROVIDERS] } }, select: { provider: true, status: true, updatedAt: true } }),
      this.prisma.auditLog.findMany({
        where: { OR: [{ action: { contains: 'credential', mode: 'insensitive' } }, { objectType: { contains: 'credential', mode: 'insensitive' } }] },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { action: true, objectType: true, result: true, createdAt: true, failureReason: true },
      }),
    ]);
    const affiliateSummary = Object.fromEntries(AFFILIATE_PLATFORMS.map((platform) => {
      const accounts = affiliateAccounts.filter((account) => account.platform.toLowerCase() === platform);
      const activeAccounts = accounts.filter((account) => account.status === CommonStatus.active);
      const activeCredentials = activeAccounts.filter((account) => account.credential?.status === CommonStatus.active);
      return [platform, {
        activeCredentialCount: activeCredentials.length,
        activeAccountCount: activeAccounts.length,
        missingCount: activeAccounts.length - activeCredentials.length,
        disabledCredentialCount: accounts.filter((account) => account.credential?.status === CommonStatus.disabled).length,
      }];
    }));
    const cardSummary = Object.fromEntries(CARD_PROVIDERS.map((provider) => {
      const credential = cardCredentials.find((row) => row.provider === provider && row.status === CommonStatus.active);
      return [provider, { configured: Boolean(credential), missing: !credential }];
    }));
    const missingBlockers = Object.values(affiliateSummary).reduce((total, value: any) => total + Number(value.missingCount ?? 0), 0)
      + Object.values(cardSummary).filter((value: any) => value.missing).length;
    return {
      data: {
        affiliate: affiliateSummary,
        cardProviders: cardSummary,
        disabledCredentialCount: affiliateAccounts.filter((account) => account.credential?.status === CommonStatus.disabled).length
          + cardCredentials.filter((credential) => credential.status === CommonStatus.disabled).length,
        missingCredentialBlockerCount: missingBlockers,
        recentCredentialChanges: recentChanges.map((item) => ({
          action: item.action,
          objectType: item.objectType,
          result: item.result,
          failureReason: item.failureReason,
          createdAt: item.createdAt,
        })),
      },
      checks: [
        check('PROVIDER_CREDENTIALS_CONFIGURED', missingBlockers > 0 ? 'warning' : 'ok', 'Provider 凭证完整性', missingBlockers > 0 ? '存在缺失的 active 凭证。' : '必要 provider 凭证已配置。', { missingCredentialBlockerCount: missingBlockers }, '在 API 凭证配置页补齐 active 凭证。'),
        check('PROVIDER_CREDENTIALS_NO_DECRYPTION', 'ok', '凭证未解密', '健康检查只读取配置计数与状态。'),
      ],
    };
  }

  private async readSettlements(now: Date): Promise<SectionResult<Record<string, unknown>>> {
    const currentMonth = getCurrentSettlementMonth(now);
    const previousMonth = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() - 1, 1));
    const [current, previous, latestLocked, lockAudits, blockedTasks] = await Promise.all([
      this.prisma.monthlySettlement.findUnique({ where: { settlementMonth: currentMonth }, select: { status: true, lockedAt: true } }),
      this.prisma.monthlySettlement.findUnique({ where: { settlementMonth: previousMonth }, select: { status: true, lockedAt: true } }),
      this.prisma.monthlySettlement.findFirst({ where: { status: SettlementStatus.locked }, orderBy: { lockedAt: 'desc' }, select: { settlementMonth: true, lockedAt: true } }),
      this.prisma.auditLog.findMany({ where: { action: { in: ['settlement.lock', 'settlement.unlock'] } }, orderBy: { createdAt: 'desc' }, take: 5, select: { action: true, result: true, settlementMonth: true, createdAt: true } }),
      this.prisma.syncTask.count({ where: { lastErrorCategory: SyncExecutionErrorCategory.MONTH_LOCKED } }),
    ]);
    return {
      data: {
        currentSettlementMonth: formatSettlementMonth(currentMonth),
        latestLockedMonth: latestLocked ? { settlementMonth: formatSettlementMonth(latestLocked.settlementMonth), lockedAt: latestLocked.lockedAt } : null,
        currentMonthLocked: current?.status === SettlementStatus.locked,
        previousMonthLocked: previous?.status === SettlementStatus.locked,
        recentLockAudit: lockAudits.map((item) => ({ action: item.action, result: item.result, settlementMonth: item.settlementMonth ? formatSettlementMonth(item.settlementMonth) : null, createdAt: item.createdAt })),
        lockedMonthBlockedSyncTaskCount: blockedTasks,
      },
      checks: [
        check('CURRENT_MONTH_LOCK_STATE', current?.status === SettlementStatus.locked ? 'ok' : 'warning', '当前工资月份锁账状态', current?.status === SettlementStatus.locked ? '当前工资月份已锁账。' : '当前工资月份未锁账。'),
        check('LOCKED_MONTH_SYNC_BLOCKERS', blockedTasks > 0 ? 'warning' : 'ok', '锁账阻塞同步任务', blockedTasks > 0 ? '存在因锁账阻塞的同步任务。' : '未发现锁账阻塞同步任务。', { lockedMonthBlockedSyncTaskCount: blockedTasks }),
      ],
    };
  }

  private async readRecentIncidents(now: Date): Promise<SectionResult<Record<string, unknown>>> {
    const [tasks, planning, audits] = await Promise.all([
      this.prisma.syncTask.findMany({
        where: { OR: [{ status: { in: [SyncTaskStatus.failed, SyncTaskStatus.retry_wait] } }, { status: SyncTaskStatus.running, leaseExpiresAt: { lte: now } }] },
        orderBy: { updatedAt: 'desc' },
        take: 20,
        select: { status: true, sourceType: true, platform: true, provider: true, settlementMonth: true, lastErrorCategory: true, errorMessage: true, updatedAt: true, leaseExpiresAt: true },
      }),
      this.prisma.syncPlanningRun.findMany({ where: { OR: [{ status: SyncPlanningRunStatus.failed }, { blockedCount: { gt: 0 } }] }, orderBy: { lastAttemptAt: 'desc' }, take: 10, select: { status: true, settlementMonth: true, blockedCount: true, blockerCodes: true, failureCode: true, lastAttemptAt: true } }),
      this.prisma.auditLog.findMany({ where: { result: AuditResult.failure, createdAt: { gte: since(now) } }, orderBy: { createdAt: 'desc' }, take: 10, select: { action: true, objectType: true, failureReason: true, errorMessage: true, createdAt: true } }),
    ]);
    const items = [
      ...tasks.map((task) => ({
        type: task.status === SyncTaskStatus.running ? 'expired_running_lease' : `sync_task_${task.status}`,
        severity: task.status === SyncTaskStatus.failed || task.status === SyncTaskStatus.running ? 'critical' : 'warning',
        title: task.status === SyncTaskStatus.running ? '过期 running 同步任务' : '异常同步任务',
        summary: safeSystemHealthText(task.errorMessage ?? task.lastErrorCategory ?? task.status),
        sourceType: task.sourceType,
        platform: task.platform,
        provider: task.provider,
        settlementMonth: formatSettlementMonth(task.settlementMonth),
        occurredAt: task.updatedAt,
        targetPath: '/data-sync',
      })),
      ...planning.map((run) => ({
        type: run.status === SyncPlanningRunStatus.failed ? 'sync_planning_failed' : 'sync_planning_blocked',
        severity: run.status === SyncPlanningRunStatus.failed ? 'critical' : 'warning',
        title: '同步规划异常',
        summary: safeSystemHealthText(run.failureCode ?? (run.blockerCodes.join(', ') || 'blocked')),
        settlementMonth: formatSettlementMonth(run.settlementMonth),
        blockedCount: run.blockedCount,
        occurredAt: run.lastAttemptAt,
        targetPath: '/data-sync',
      })),
      ...audits.map((audit) => ({
        type: 'audit_failure',
        severity: 'warning',
        title: '审计失败事件',
        summary: safeSystemHealthText(audit.errorMessage ?? audit.failureReason ?? audit.action),
        action: audit.action,
        objectType: audit.objectType,
        occurredAt: audit.createdAt,
        targetPath: '/audit-logs',
      })),
    ].sort((a, b) => new Date(b.occurredAt as Date).getTime() - new Date(a.occurredAt as Date).getTime()).slice(0, 20);
    return {
      data: { items },
      checks: [
        check('RECENT_INCIDENTS_PRESENT', items.length > 0 ? 'warning' : 'ok', '最近异常事件', items.length > 0 ? `发现 ${items.length} 条异常摘要。` : '最近未发现关键异常事件。', { incidentCount: items.length }),
      ],
    };
  }

  private async readDataProtection(now: Date): Promise<SectionResult<Record<string, unknown>>> {
    const health = await this.backupHealth.getHealth(now);
    const criticalBackupAlerts = await this.prisma.alert.count({
      where: {
        status: { in: ['active', 'silenced'] },
        severity: 'critical',
        source: { in: ['backup', 'restore_drill'] },
      },
    }).catch(() => 0);
    return {
      data: {
        status: health.status,
        latestSuccessfulBackup: health.latestSuccessfulBackup,
        latestSuccessfulRestoreDrill: health.latestSuccessfulRestoreDrill,
        daysSinceLastSuccessBackup: health.daysSinceLastSuccessBackup,
        daysSinceLastSuccessDrill: health.daysSinceLastSuccessDrill,
        criticalBackupAlertActive: criticalBackupAlerts > 0,
        documentation: 'Backups and restores are executed by operations or CI; this system records sanitized metadata only.',
      },
      checks: [
        check('DATA_PROTECTION_BACKUP_HEALTH', health.status, '数据保全备份健康', `备份健康状态为 ${health.status}。`, { backupHealthStatus: health.status }),
        check('DATA_PROTECTION_CRITICAL_ALERT', criticalBackupAlerts > 0 ? 'critical' : 'ok', '数据保全 critical 告警', criticalBackupAlerts > 0 ? '存在 active/silenced critical 数据保全告警。' : '未发现 active/silenced critical 数据保全告警。', { criticalBackupAlertCount: criticalBackupAlerts }),
        ...health.checks.map((item) => check(`DATA_PROTECTION_${item.code.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, item.status, item.code, item.message, item.safeDetails ?? {})),
      ],
    };
  }

  private async readAudit(now: Date): Promise<SectionResult<Record<string, unknown>>> {
    const [superAdmins, enabledSuperAdmins, recentPermissionChanges, recentAdminChanges, recentExport, auditFailureCount] = await Promise.all([
      this.prisma.adminUser.count({ where: { roles: { some: { role: { code: 'super_admin' } } } } }),
      this.prisma.adminUser.count({ where: { status: CommonStatus.active, roles: { some: { role: { code: 'super_admin', status: CommonStatus.active } } } } }),
      this.prisma.auditLog.findMany({ where: { OR: [{ action: { startsWith: 'role.' } }, { action: { contains: 'permission', mode: 'insensitive' } }] }, orderBy: { createdAt: 'desc' }, take: 5, select: { action: true, result: true, createdAt: true, failureReason: true } }),
      this.prisma.auditLog.findMany({ where: { action: { startsWith: 'admin_user.' } }, orderBy: { createdAt: 'desc' }, take: 5, select: { action: true, result: true, createdAt: true, failureReason: true } }),
      this.prisma.auditLog.findFirst({ where: { action: { contains: 'audit', mode: 'insensitive' }, objectType: { contains: 'export', mode: 'insensitive' } }, orderBy: { createdAt: 'desc' }, select: { action: true, result: true, createdAt: true } }),
      this.prisma.auditLog.count({ where: { result: AuditResult.failure, createdAt: { gte: since(now) } } }),
    ]);
    let writable = true;
    try {
      await this.prisma.auditLog.count({ take: 1 });
    } catch {
      writable = false;
    }
    return {
      data: {
        superAdminCount: superAdmins,
        enabledSuperAdminCount: enabledSuperAdmins,
        enabledSuperAdminSafe: enabledSuperAdmins >= 1,
        recentPermissionChanges,
        recentAdminStatusChanges: recentAdminChanges,
        recentAuditExport: recentExport,
        auditLogWritable: writable,
        auditFailuresLast24h: auditFailureCount,
      },
      checks: [
        check('ENABLED_SUPER_ADMIN_PRESENT', enabledSuperAdmins >= 1 ? 'ok' : 'critical', '可用 super_admin', enabledSuperAdmins >= 1 ? '至少存在一个启用的 super_admin。' : '没有启用的 super_admin。', { enabledSuperAdminCount: enabledSuperAdmins }),
        check('AUDIT_LOG_READABLE', writable ? 'ok' : 'critical', '审计日志可读', writable ? '审计日志表可查询。' : '审计日志表查询失败。'),
        check('AUDIT_FAILURE_COUNT', auditFailureCount > 0 ? 'warning' : 'ok', '24 小时审计失败数', `最近 24 小时审计失败数为 ${auditFailureCount}。`, { auditFailureCount }),
      ],
    };
  }

  private async readE2e(now: Date): Promise<SectionResult<Record<string, unknown>>> {
    const packageJson = readRootPackageJson<Record<string, { e2e?: string }>>();
    const hasCommand = Boolean(packageJson?.scripts && Object.prototype.hasOwnProperty.call(packageJson.scripts, 'e2e:permissions'));
    const scriptPath = resolve(projectRoot(), 'scripts', process.platform === 'win32' ? 'e2e-permissions.ps1' : 'e2e-permissions.ts');
    const envCheckHasApi = false;
    return {
      data: {
        permissionsE2eCommandExists: hasCommand,
        permissionsE2eScriptExists: existsSync(scriptPath),
        latestPermissionsE2eRun: { persisted: false, message: '未持久化，需要运维执行 pnpm e2e:permissions。' },
        documentation: { path: 'docs/e2e-permissions.md' },
        envCheckReadableViaApi: envCheckHasApi,
        envCheckStatus: 'not_persisted_run_pnpm_env_check',
        checkedAt: now.toISOString(),
      },
      checks: [
        check('E2E_PERMISSIONS_COMMAND_EXISTS', hasCommand ? 'ok' : 'warning', '权限 E2E 命令', hasCommand ? 'package.json 存在 pnpm e2e:permissions。' : 'package.json 缺少 e2e:permissions 命令。'),
        check('ENV_CHECK_API_RESULT', 'ok', 'env:check API 结果', '项目未持久化 env:check 运行结果，需运维命令确认。'),
      ],
    };
  }

  private async countAuditFailures(now: Date, reasons: string[]) {
    try {
      return await this.prisma.auditLog.count({ where: { result: AuditResult.failure, createdAt: { gte: since(now) }, failureReason: { in: reasons } } });
    } catch {
      return null;
    }
  }
}

function check(
  code: string,
  status: SystemHealthStatus,
  title: string,
  message: string,
  safeDetails: Record<string, unknown> = {},
  remediation = '',
): SystemHealthCheck {
  return { code, status, title, message, safeDetails, remediation, updatedAt: new Date().toISOString() };
}

function aggregateStatus(checks: SystemHealthCheck[]): SystemHealthStatus {
  if (checks.some((item) => item.status === 'critical')) return 'critical';
  if (checks.some((item) => item.status === 'warning')) return 'warning';
  return 'ok';
}

function since(now: Date) {
  return new Date(now.getTime() - QUERY_WINDOW_24H_MS);
}

function parsePort(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function readPackageVersion() {
  return readRootPackageJson<{ version?: string }>()?.version ?? 'unknown';
}

function readRootPackageJson<T>(): T | null {
  return readJson<T>(resolve(projectRoot(), 'package.json'));
}

function projectRoot() {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return process.cwd();
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
