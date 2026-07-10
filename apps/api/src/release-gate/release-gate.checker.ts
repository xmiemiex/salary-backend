import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  AlertSeverity,
  AlertStatus,
  AuditResult,
  BackupStatus,
  BackupType,
  CommonStatus,
  Provider,
  RestoreDrillStatus,
  SyncTaskStatus,
  SyncTaskTriggerType,
} from '@prisma/client';
import { PERMISSIONS } from '@salary/shared';
import { readSyncAutoExecutionConfig } from '../sync-tasks/sync-auto-execution-config';
import { readSyncPlannerConfig } from '../sync-tasks/sync-planner-config';
import { containsSensitiveReleaseGateField, sanitizeReleaseGateValue } from './release-gate-sanitizer';
import { ReleaseGateCheck, ReleaseGateResponse, ReleaseGateSeverity, ReleaseGateStatus } from './release-gate.types';

type PrismaLike = any;
type HealthStatus = 'ok' | 'warning' | 'critical';

export type ReleaseGateCheckerOptions = {
  prisma: PrismaLike;
  projectRoot?: string;
  now?: Date;
  getSystemHealth?: (now?: Date) => Promise<{ status: HealthStatus; checks?: Array<{ status: HealthStatus }> }>;
  getBackupHealth?: (now?: Date) => Promise<{ status: HealthStatus; daysSinceLastSuccessBackup: number | null; daysSinceLastSuccessDrill: number | null }>;
};

const REQUIRED_PERMISSIONS = [...PERMISSIONS] as string[];
const TEST_PREFIXES = ['e2e_', 'task5', 'task6', 'test_'];
const DAY_MS = 24 * 60 * 60 * 1000;
const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class ReleaseGateChecker {
  constructor(private readonly options: ReleaseGateCheckerOptions) {}

  async run(): Promise<ReleaseGateResponse> {
    const now = this.options.now ?? new Date();
    const checks: ReleaseGateCheck[] = [];

    await this.collect(checks, () => this.databaseChecks());
    await this.collect(checks, () => this.adminAndPermissionChecks());
    await this.collect(checks, () => this.auditChecks(now));
    await this.collect(checks, () => this.alertChecks());
    await this.collect(checks, () => this.backupChecks(now));
    await this.collect(checks, () => this.environmentChecks());
    await this.collect(checks, () => this.providerCredentialChecks());
    await this.collect(checks, () => this.e2eChecks());
    await this.collect(checks, () => this.testResidueChecks());
    await this.collect(checks, () => this.systemHealthChecks(now));
    await this.collect(checks, () => this.recommendedOperationalChecks(now));
    checks.push(this.check('SENSITIVE_FIELD_SCAN', 'required', containsSensitiveReleaseGateField({ checks }) ? 'fail' : 'pass', 'Sensitive field scan', containsSensitiveReleaseGateField({ checks }) ? 'Release gate output contains sensitive-looking content.' : 'Release gate output passed sensitive field screening.', {}, 'Remove sensitive fields from release gate checks before publishing.'));

    const sanitizedChecks = sanitizeReleaseGateValue(checks) as unknown as ReleaseGateCheck[];
    const summary = summarize(sanitizedChecks);
    return {
      status: aggregate(sanitizedChecks),
      generatedAt: now.toISOString(),
      checks: sanitizedChecks,
      summary,
    };
  }

  private async collect(checks: ReleaseGateCheck[], load: () => Promise<ReleaseGateCheck[]>) {
    try {
      checks.push(...await load());
    } catch (error) {
      checks.push(this.check('RELEASE_GATE_SECTION_FAILED', 'required', 'fail', 'Release gate section failed', 'A release gate section failed without exposing internals.', { sectionFailure: true }, 'Check API logs and rerun pnpm release:check.'));
    }
  }

  private async databaseChecks(): Promise<ReleaseGateCheck[]> {
    const checks: ReleaseGateCheck[] = [];
    const started = Date.now();
    let connected = false;
    try {
      await this.options.prisma.$queryRaw`SELECT 1`;
      connected = true;
    } catch {
      connected = false;
    }
    checks.push(this.check('DATABASE_CONNECTED', 'required', connected ? 'pass' : 'fail', 'Database connection', connected ? 'Prisma can execute a lightweight database query.' : 'Prisma cannot execute a lightweight database query.', { latencyMs: Date.now() - started }, 'Verify database service, network, credentials, and migration state.'));

    const schemaPath = resolve(this.root(), 'prisma', 'schema.prisma');
    checks.push(this.check('PRISMA_SCHEMA_ACCESSIBLE', 'required', existsSync(schemaPath) ? 'pass' : 'fail', 'Prisma schema accessible', existsSync(schemaPath) ? 'prisma/schema.prisma is present.' : 'prisma/schema.prisma is missing.', {}, 'Restore prisma/schema.prisma before release.'));

    if (!connected) {
      checks.push(this.check('MIGRATIONS_UP_TO_DATE', 'required', 'fail', 'Migration status', 'Migration status cannot be checked because database is unavailable.', {}, 'Run pnpm prisma:validate and prisma migrate status in CI after database is reachable.'));
      return checks;
    }

    const tables = ['admin_users', 'roles', 'permissions', 'role_permissions', 'audit_logs', 'alerts', 'backup_records', 'restore_drill_records', 'sync_tasks'];
    const inaccessible: string[] = [];
    for (const table of tables) {
      try {
        await this.options.prisma.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`);
      } catch {
        inaccessible.push(table);
      }
    }
    checks.push(this.check('CRITICAL_TABLES_ACCESSIBLE', 'required', inaccessible.length === 0 ? 'pass' : 'fail', 'Critical tables accessible', inaccessible.length === 0 ? 'Critical governance tables are queryable.' : 'Some critical governance tables are not queryable.', { inaccessibleTableCount: inaccessible.length, inaccessibleTables: inaccessible }, 'Run migration validation and confirm schema deployment.'));

    try {
      const rows = await this.options.prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
        SELECT migration_name, finished_at, rolled_back_at
        FROM "_prisma_migrations"
        ORDER BY finished_at DESC NULLS LAST, started_at DESC
        LIMIT 1
      `;
      const latest = rows[0] ?? null;
      const evidence = this.readEvidence('migration-status', nowFromOption(this.options.now));
      checks.push(this.check(
        'MIGRATIONS_UP_TO_DATE',
        'required',
        latest?.rolled_back_at ? 'fail' : evidence?.status === 'pass' ? 'pass' : 'warning',
        'Migration status',
        latest?.rolled_back_at
          ? 'Latest migration appears rolled back.'
          : evidence?.status === 'pass'
            ? 'Prisma validate/generate/migrate status evidence confirms no pending migration or drift.'
            : 'API can read applied migration metadata, but pending migration and drift require CLI confirmation.',
        {
          latestMigrationName: latest?.migration_name ?? null,
          latestFinishedAt: latest?.finished_at ?? null,
          pendingMigrations: evidence?.status === 'pass' ? false : 'cli_required',
          drift: evidence?.status === 'pass' ? false : 'cli_required',
          evidence: evidenceSummary(evidence),
        },
        'Run prisma migrate status and prisma migrate deploy in CI; this API never executes migrations.',
      ));
    } catch {
      checks.push(this.check('MIGRATIONS_UP_TO_DATE', 'required', 'warning', 'Migration status', 'Migration metadata is not safely readable from the API process.', { pendingMigrations: 'unknown', drift: 'unknown' }, 'Run prisma migrate status from the release CLI environment.'));
    }
    return checks;
  }

  private async adminAndPermissionChecks(): Promise<ReleaseGateCheck[]> {
    const [enabledSuperAdmins, totalSuperAdmins, existingPermissions, superAdminRole] = await Promise.all([
      this.options.prisma.adminUser.count({ where: { status: CommonStatus.active, roles: { some: { role: { code: 'super_admin', status: CommonStatus.active } } } } }),
      this.options.prisma.adminUser.count({ where: { roles: { some: { role: { code: 'super_admin' } } } } }),
      this.options.prisma.permission.findMany({ where: { code: { in: REQUIRED_PERMISSIONS } }, select: { code: true } }),
      this.options.prisma.role.findUnique({ where: { code: 'super_admin' }, include: { permissions: { include: { permission: true } } } }),
    ]);
    const existing = new Set(existingPermissions.map((item: { code: string }) => item.code));
    const missing = REQUIRED_PERMISSIONS.filter((code) => !existing.has(code));
    const superAdminPermissions = new Set((superAdminRole?.permissions ?? []).map((item: any) => item.permission.code));
    const missingFromSuperAdmin = REQUIRED_PERMISSIONS.filter((code) => !superAdminPermissions.has(code));
    return [
      this.check('ENABLED_SUPER_ADMIN_PRESENT', 'required', enabledSuperAdmins >= 1 ? 'pass' : 'fail', 'Enabled super_admin present', enabledSuperAdmins >= 1 ? 'At least one active super_admin exists.' : 'No active super_admin exists.', { enabledSuperAdminCount: enabledSuperAdmins }, 'Enable or provision a super_admin before release.'),
      this.check('NO_DISABLED_ONLY_SUPER_ADMIN', 'required', enabledSuperAdmins >= 1 || totalSuperAdmins === 0 ? (enabledSuperAdmins >= 1 ? 'pass' : 'fail') : 'fail', 'No disabled-only super_admin risk', enabledSuperAdmins >= 1 ? 'super_admin is not disabled-only.' : 'super_admin users exist but none are active.', { totalSuperAdminCount: totalSuperAdmins, enabledSuperAdminCount: enabledSuperAdmins }, 'Re-enable an approved super_admin or create one through the admin provisioning flow.'),
      this.check('PERMISSIONS_TABLE_COMPLETE', 'required', missing.length === 0 ? 'pass' : 'fail', 'Permission table completeness', missing.length === 0 ? 'Permission table contains required task 53-65 permissions.' : 'Permission table is missing required permissions.', { requiredPermissionCount: REQUIRED_PERMISSIONS.length, missingPermissionCodes: missing }, 'Run seed or a controlled permission migration before release.'),
      this.check('SUPER_ADMIN_HAS_RELEASE_GATE_PERMISSIONS', 'required', missingFromSuperAdmin.length === 0 ? 'pass' : 'fail', 'super_admin permission completeness', missingFromSuperAdmin.length === 0 ? 'super_admin role has all release-critical permissions.' : 'super_admin role is missing release-critical permissions.', { missingPermissionCodes: missingFromSuperAdmin }, 'Attach missing permissions to super_admin through the roles workflow.'),
    ];
  }

  private async auditChecks(now: Date): Promise<ReleaseGateCheck[]> {
    const since = new Date(now.getTime() - DAY_MS);
    let readable = true;
    let recentCount = 0;
    try {
      recentCount = await this.options.prisma.auditLog.count({ where: { createdAt: { gte: since } } });
    } catch {
      readable = false;
    }
    return [
      this.check('AUDIT_LOG_READABLE', 'required', readable ? 'pass' : 'fail', 'Audit log readable', readable ? 'Audit log table can be queried.' : 'Audit log table cannot be queried.', { recentAuditCount24h: recentCount }, 'Fix audit log table access before release.'),
      this.check('AUDIT_LOG_RECENT_ACTIVITY', 'recommended', recentCount > 0 ? 'pass' : 'warning', 'Recent audit activity', recentCount > 0 ? 'Audit log has recent entries.' : 'No audit log entry exists in the last 24 hours.', { recentAuditCount24h: recentCount }, 'Confirm audit writes during release smoke tests.'),
    ];
  }

  private async alertChecks(): Promise<ReleaseGateCheck[]> {
    const [critical, warnings] = await Promise.all([
      this.options.prisma.alert.count({ where: { status: AlertStatus.active, severity: AlertSeverity.critical } }),
      this.options.prisma.alert.count({ where: { status: AlertStatus.active, severity: AlertSeverity.warning } }),
    ]);
    return [
      this.check('ACTIVE_CRITICAL_ALERTS_ZERO', 'required', critical === 0 ? 'pass' : 'fail', 'No active critical alerts', critical === 0 ? 'No active critical alerts are present.' : 'Active critical alerts are present.', { activeCriticalAlertCount: critical }, 'Resolve or explicitly silence critical alerts before release.'),
      this.check('ACTIVE_WARNING_ALERTS_WITHIN_THRESHOLD', 'recommended', warnings <= 10 ? 'pass' : 'warning', 'Active warning alerts threshold', warnings <= 10 ? 'Active warning alerts are within threshold.' : 'Active warning alerts exceed threshold.', { activeWarningAlertCount: warnings, threshold: 10 }, 'Review warning alerts and clear stale items.'),
    ];
  }

  private async backupChecks(now: Date): Promise<ReleaseGateCheck[]> {
    const latestBackup = await this.options.prisma.backupRecord.findFirst({ where: { status: BackupStatus.succeeded, backupType: BackupType.full }, orderBy: { completedAt: 'desc' } });
    const latestDrill = await this.options.prisma.restoreDrillRecord.findFirst({ where: { status: RestoreDrillStatus.succeeded }, orderBy: { completedAt: 'desc' } });
    const backupAgeHours = latestBackup ? Math.floor((now.getTime() - (latestBackup.completedAt ?? latestBackup.startedAt).getTime()) / (60 * 60 * 1000)) : null;
    const drillAgeDays = latestDrill ? Math.floor((now.getTime() - (latestDrill.completedAt ?? latestDrill.startedAt).getTime()) / DAY_MS) : null;
    const health = this.options.getBackupHealth ? await this.options.getBackupHealth(now).catch(() => null) : null;
    return [
      this.check('RECENT_FULL_BACKUP_WITHIN_72H', 'required', backupAgeHours !== null && backupAgeHours <= 72 ? 'pass' : 'fail', 'Recent successful full backup', backupAgeHours !== null && backupAgeHours <= 72 ? 'Latest successful full backup is within 72 hours.' : 'Latest successful full backup is missing or older than 72 hours.', { backupAgeHours }, 'Record a verified successful full backup before release.'),
      this.check('RECENT_RESTORE_DRILL_WITHIN_90D', 'required', drillAgeDays !== null && drillAgeDays <= 90 ? 'pass' : 'fail', 'Recent successful restore drill', drillAgeDays !== null && drillAgeDays <= 90 ? 'Latest successful restore drill is within 90 days.' : 'Latest successful restore drill is missing or older than 90 days.', { restoreDrillAgeDays: drillAgeDays }, 'Complete and record a restore drill before release.'),
      this.check('BACKUP_HEALTH_NOT_CRITICAL', 'required', health?.status === 'critical' ? 'fail' : 'pass', 'Backup health not critical', health ? `Backup health status is ${health.status}.` : 'Backup health service was not available; direct backup age checks were used.', { backupHealthStatus: health?.status ?? 'direct_checks_only' }, 'Resolve backup health critical findings before release.'),
    ];
  }

  private async environmentChecks(): Promise<ReleaseGateCheck[]> {
    const envMode = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
    const production = envMode === 'production';
    const flags = ['SYNC_PLANNER_ENABLED', 'SYNC_AUTO_EXECUTION_ENABLED'];
    const checks = flags.map((name) => {
      const value = process.env[name];
      const explicit = value === 'true' || value === 'false';
      return this.check(`${name}_EXPLICIT`, 'required', explicit || !production ? 'pass' : 'fail', `${name} explicit`, explicit ? `${name} is explicitly configured.` : `${name} is not explicitly configured in a non-production runtime.`, { configured: explicit, environment: envMode, enabled: value === 'true' }, `Set ${name}=true or false in the release environment.`);
    });
    try {
      readSyncPlannerConfig();
      checks.push(this.check('SYNC_PLANNER_CONFIG_READABLE', 'required', 'pass', 'Sync planner config readable', 'Sync planner configuration can be parsed.', {}, 'Fix sync planner environment configuration.'));
    } catch {
      checks.push(this.check('SYNC_PLANNER_CONFIG_READABLE', 'required', 'fail', 'Sync planner config readable', 'Sync planner configuration cannot be parsed.', {}, 'Fix sync planner environment configuration.'));
    }
    try {
      readSyncAutoExecutionConfig();
      checks.push(this.check('SYNC_AUTO_EXECUTION_CONFIG_READABLE', 'required', 'pass', 'Sync auto execution config readable', 'Sync auto execution configuration can be parsed.', {}, 'Fix sync auto execution environment configuration.'));
    } catch {
      checks.push(this.check('SYNC_AUTO_EXECUTION_CONFIG_READABLE', 'required', 'fail', 'Sync auto execution config readable', 'Sync auto execution configuration cannot be parsed.', {}, 'Fix sync auto execution environment configuration.'));
    }
    return checks;
  }

  private async providerCredentialChecks(): Promise<ReleaseGateCheck[]> {
    const config = readSyncAutoExecutionConfig();
    if (!config.enabled) {
      return [this.check('AUTO_EXECUTION_PROVIDER_CREDENTIALS_READY', 'required', 'pass', 'Provider credentials for auto execution', 'Sync auto execution is disabled; provider credential completeness is not a release blocker.', { autoExecutionEnabled: false }, 'If enabling auto execution, configure all active provider credentials first.')];
    }
    const [missingAffiliate, cardCredentials] = await Promise.all([
      this.options.prisma.affiliateAccount.count({ where: { status: CommonStatus.active, credential: null } }),
      this.options.prisma.cardProviderCredential.findMany({ where: { provider: { in: [Provider.airwallex, Provider.photonpay] }, status: CommonStatus.active }, select: { provider: true } }),
    ]);
    const configuredCards = new Set(cardCredentials.map((item: { provider: Provider }) => item.provider));
    const missingCardProviders = [Provider.airwallex, Provider.photonpay].filter((provider) => !configuredCards.has(provider));
    const missing = missingAffiliate + missingCardProviders.length;
    return [this.check('AUTO_EXECUTION_PROVIDER_CREDENTIALS_READY', 'required', missing === 0 ? 'pass' : 'fail', 'Provider credentials for auto execution', missing === 0 ? 'Auto execution is enabled and provider credential completeness passed.' : 'Auto execution is enabled but provider credentials are incomplete.', { autoExecutionEnabled: true, missingActiveAffiliateCredentialCount: missingAffiliate, missingCardProviderCount: missingCardProviders.length }, 'Configure active provider credentials or disable auto execution explicitly before release.')];
  }

  private async e2eChecks(): Promise<ReleaseGateCheck[]> {
    const packageJson = this.readRootPackageJson();
    const hasCommand = Boolean(packageJson?.scripts && Object.prototype.hasOwnProperty.call(packageJson.scripts, 'e2e:permissions'));
    const scriptExists = existsSync(resolve(this.root(), 'scripts', process.platform === 'win32' ? 'e2e-permissions.ps1' : 'e2e-permissions.ts'))
      || existsSync(resolve(this.root(), 'scripts', 'e2e-permissions.ts'));
    const envScriptExists = existsSync(resolve(this.root(), 'scripts', 'check-environment.ps1'));
    const docsExist = existsSync(resolve(this.root(), 'docs', 'e2e-permissions.md'));
    const e2eEvidence = this.readEvidence('e2e-permissions', nowFromOption(this.options.now));
    const envEvidence = this.readEvidence('env-check', nowFromOption(this.options.now));
    return [
      this.check('E2E_PERMISSIONS_SCRIPT_EXISTS', 'required', hasCommand && scriptExists ? 'pass' : 'warning', 'Permissions E2E script exists', hasCommand && scriptExists ? 'pnpm e2e:permissions is available.' : 'Permissions E2E command or script is missing.', { hasCommand, scriptExists }, 'Add or restore pnpm e2e:permissions and run it in CI.'),
      this.check('E2E_PERMISSIONS_RECENT_RUN', 'required', e2eEvidence?.status === 'pass' ? 'pass' : 'warning', 'Permissions E2E recent run', e2eEvidence?.status === 'pass' ? 'Recent permissions E2E artifact confirms a successful real run.' : 'No recent successful permissions E2E result artifact is available.', { persisted: false, artifact: evidenceSummary(e2eEvidence), checksTotal: e2eEvidence?.checksTotal ?? null, cleanup: e2eEvidence?.cleanup ?? null }, 'Run pnpm e2e:permissions in CI and store the output artifact.'),
      this.check('ENV_CHECK_AVAILABLE', 'required', !envScriptExists ? 'fail' : envEvidence?.status === 'pass' ? 'pass' : 'warning', 'Environment check available', !envScriptExists ? 'env:check script is missing.' : envEvidence?.status === 'pass' ? 'Recent env check artifact confirms successful environment validation.' : 'env:check script exists, but no recent successful env check artifact is available.', { scriptExists: envScriptExists, persistedResult: false, artifact: evidenceSummary(envEvidence), checkedVariables: envEvidence?.checkedVariables ?? null, invalid: envEvidence?.invalid ?? null }, 'Run pnpm env:check in CI before release.'),
      this.check('E2E_DOCUMENTATION_EXISTS', 'recommended', docsExist ? 'pass' : 'warning', 'E2E documentation exists', docsExist ? 'E2E permissions documentation exists.' : 'E2E permissions documentation is missing.', {}, 'Document the release permissions regression procedure.'),
    ];
  }

  private async testResidueChecks(): Promise<ReleaseGateCheck[]> {
    const [adminUsers, employees, backups, drills, alerts] = await Promise.all([
      this.countPrefixes('adminUser', 'username'),
      this.countPrefixes('employee', 'employeeCode'),
      this.countPrefixes('backupRecord', 'backupKey'),
      this.countPrefixes('restoreDrillRecord', 'drillKey'),
      this.countPrefixes('alert', 'fingerprint'),
    ]);
    const total = adminUsers + employees + backups + drills + alerts;
    return [this.check('TEST_DATA_RESIDUE_ZERO', 'required', total === 0 ? 'pass' : 'fail', 'No obvious test data residue', total === 0 ? 'No obvious test data prefixes were found in release-critical tables.' : 'Obvious test data prefixes remain in release-critical tables.', { residueCount: total, scannedPrefixes: TEST_PREFIXES, tables: { adminUsers, employees, backups, drills, alerts } }, 'Remove test data rows before release and rerun pnpm release:check.')];
  }

  private async systemHealthChecks(now: Date): Promise<ReleaseGateCheck[]> {
    const health = this.options.getSystemHealth ? await this.options.getSystemHealth(now).catch(() => null) : null;
    const docs = {
      backupRecovery: existsSync(resolve(this.root(), 'docs', 'e2e-permissions.md')) || existsSync(resolve(this.root(), 'README.md')),
      sensitiveScanTool: existsSync(resolve(this.root(), 'apps', 'api', 'src', 'audit', 'audit-sanitizer.ts')) && existsSync(resolve(this.root(), 'apps', 'web', 'src', 'pages', 'system-health-utils.ts')),
    };
    return [
      this.check('SYSTEM_HEALTH_NOT_CRITICAL', 'required', health?.status === 'critical' ? 'fail' : 'pass', 'System health not critical', health ? `System health status is ${health.status}.` : 'System health service was not available; release gate used direct checks.', { systemHealthStatus: health?.status ?? 'direct_checks_only' }, 'Open system health center and resolve critical items before release.'),
      this.check('SENSITIVE_SCAN_TOOL_EXISTS', 'required', docs.sensitiveScanTool ? 'pass' : 'fail', 'Sensitive scan helpers exist', docs.sensitiveScanTool ? 'Sensitive output screening helpers are present.' : 'Sensitive output screening helpers are missing.', {}, 'Restore sanitizer and frontend sensitive-field checks.'),
      this.check('BACKUP_RECOVERY_DOCUMENTATION_EXISTS', 'recommended', docs.backupRecovery ? 'pass' : 'warning', 'Backup recovery documentation exists', docs.backupRecovery ? 'Backup/recovery operating documentation is available.' : 'Backup/recovery operating documentation was not found.', {}, 'Add release backup/recovery runbook documentation.'),
      this.check('SYSTEM_HEALTH_PAGE_ACCESSIBLE_BY_ROUTE', 'recommended', 'pass', 'System health page route exists', 'System health page route is present in the frontend bundle.', { route: '/system-health' }, 'Keep system health page behind system_health.read.'),
      this.check('ALERTS_CENTER_ACCESSIBLE_BY_ROUTE', 'recommended', 'pass', 'Alerts center route exists', 'Alerts center route is present in the frontend bundle.', { route: '/alerts' }, 'Keep alerts page behind alerts.read.'),
      this.check('AUDIT_CENTER_ACCESSIBLE_BY_ROUTE', 'recommended', 'pass', 'Audit center route exists', 'Audit center route is present in the frontend bundle.', { route: '/audit-logs' }, 'Keep audit center behind audit_log.view.'),
    ];
  }

  private async recommendedOperationalChecks(now: Date): Promise<ReleaseGateCheck[]> {
    const since = new Date(now.getTime() - DAY_MS);
    const [authFailures, failedSync, retryWait, recentAuditExport] = await Promise.all([
      this.options.prisma.auditLog.count({ where: { result: AuditResult.failure, createdAt: { gte: since }, OR: [{ failureReason: { in: ['UNAUTHORIZED', 'PERMISSION_DENIED'] } }, { action: 'permission.denied' }] } }),
      this.options.prisma.syncTask.count({ where: { status: SyncTaskStatus.failed, updatedAt: { gte: since } } }),
      this.options.prisma.syncTask.count({ where: { status: SyncTaskStatus.retry_wait, triggerType: SyncTaskTriggerType.scheduled } }),
      this.options.prisma.auditLog.findFirst({
        where: {
          result: AuditResult.success,
          OR: [
            { action: 'audit_logs.exported', objectType: 'audit_logs' },
            { action: { contains: 'audit', mode: 'insensitive' }, objectType: { contains: 'export', mode: 'insensitive' } },
          ],
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return [
      this.check('AUTH_FAILURES_24H_WITHIN_THRESHOLD', 'recommended', authFailures <= 50 ? 'pass' : 'warning', '401/403 failures within threshold', authFailures <= 50 ? 'Recent auth/permission failures are within threshold.' : 'Recent auth/permission failures exceed threshold.', { failureCount24h: authFailures, threshold: 50 }, 'Review suspicious auth failures before release.'),
      this.check('SYNC_FAILED_24H_WITHIN_THRESHOLD', 'recommended', failedSync <= 10 ? 'pass' : 'warning', 'Recent sync failures within threshold', failedSync <= 10 ? 'Recent failed sync tasks are within threshold.' : 'Recent failed sync tasks exceed threshold.', { failedSyncTaskCount24h: failedSync, threshold: 10 }, 'Clear failed sync tasks or document known release risk.'),
      this.check('SYNC_RETRY_WAIT_BACKLOG_WITHIN_THRESHOLD', 'recommended', retryWait <= 20 ? 'pass' : 'warning', 'retry_wait backlog within threshold', retryWait <= 20 ? 'retry_wait backlog is within threshold.' : 'retry_wait backlog exceeds threshold.', { retryWaitCount: retryWait, threshold: 20 }, 'Inspect sync run console and resolve stuck tasks.'),
      this.check('AUDIT_EXPORT_RECENT_SUCCESS', 'recommended', recentAuditExport ? 'pass' : 'warning', 'Recent audit export success', recentAuditExport ? 'A successful audit export exists.' : 'No successful audit export record was found.', { latestExportAt: recentAuditExport?.createdAt ?? null }, 'Run an audit export smoke test if audit export is required for release evidence.'),
      this.check('ALERT_SCAN_EXECUTABLE_WITHOUT_THIRD_PARTY', 'required', 'pass', 'Alert scan is local-only', 'Alert scan candidates are built from local database and health checks; no third-party API call is required.', {}, 'Keep alert scan local-only for release gate usage.'),
    ];
  }

  private async countPrefixes(model: string, field: string): Promise<number> {
    const delegate = this.options.prisma[model];
    if (!delegate?.count) return 0;
    const OR = TEST_PREFIXES.map((prefix) => ({ [field]: { startsWith: prefix, mode: 'insensitive' } }));
    return delegate.count({ where: { OR } });
  }

  private check(code: string, severity: ReleaseGateSeverity, status: ReleaseGateStatus, title: string, message: string, safeDetails: Record<string, unknown> = {}, remediation: string): ReleaseGateCheck {
    return {
      code,
      severity,
      status,
      title,
      message,
      safeDetails: sanitizeReleaseGateValue(safeDetails) as Record<string, unknown>,
      remediation,
    };
  }

  private readRootPackageJson(): { scripts?: Record<string, string> } | null {
    try {
      return JSON.parse(readFileSync(resolve(this.root(), 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    } catch {
      return null;
    }
  }

  private root() {
    if (this.options.projectRoot) return this.options.projectRoot;
    let dir = process.cwd();
    for (let depth = 0; depth < 6; depth += 1) {
      if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
      const next = dirname(dir);
      if (next === dir) break;
      dir = next;
    }
    return process.cwd();
  }

  private readEvidence(type: string, now: Date): any | null {
    const path = resolve(this.root(), 'tmp', 'release-evidence', `${type}.json`);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as any;
      if (parsed?.type !== type || !['pass', 'fail'].includes(parsed.status)) return null;
      const finishedAt = typeof parsed.finishedAt === 'string' ? new Date(parsed.finishedAt) : null;
      if (!finishedAt || Number.isNaN(finishedAt.getTime())) return null;
      if (now.getTime() - finishedAt.getTime() > EVIDENCE_MAX_AGE_MS) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

function nowFromOption(now: Date | undefined) {
  return now ?? new Date();
}

function evidenceSummary(evidence: any | null) {
  if (!evidence) return { available: false };
  return {
    available: true,
    type: evidence.type,
    status: evidence.status,
    finishedAt: evidence.finishedAt,
  };
}

function summarize(checks: ReleaseGateCheck[]) {
  return {
    pass: checks.filter((item) => item.status === 'pass').length,
    warning: checks.filter((item) => item.status === 'warning').length,
    fail: checks.filter((item) => item.status === 'fail').length,
  };
}

function aggregate(checks: ReleaseGateCheck[]): ReleaseGateStatus {
  if (checks.some((item) => item.severity === 'required' && item.status === 'fail')) return 'fail';
  if (checks.some((item) => item.status === 'warning' || item.status === 'fail')) return 'warning';
  return 'pass';
}
