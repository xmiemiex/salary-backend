'use strict';

const { readFileSync, writeFileSync } = require('node:fs');

const command = process.argv[2];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function fail(message) {
  console.error(`TASK85_HELPER_ERROR=${message}`);
  process.exit(1);
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : 'none';
}

function ageHours(value, now = new Date()) {
  if (!(value instanceof Date)) return -1;
  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / 3_600_000));
}

function ageDays(value, now = new Date()) {
  if (!(value instanceof Date)) return -1;
  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / 86_400_000));
}

async function databaseSummary() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const now = new Date();
  const safeQuery = async (name, load) => {
    try {
      return await load();
    } catch {
      console.error(`TASK85_DB_QUERY_FAILED=${name}`);
      throw new Error(`safe database summary query failed: ${name}`);
    }
  };
  try {
    const [
      activeAdmins,
      activeSuperAdmins,
      activeLowPrivilegeAdmins,
      task84Accounts,
      activeSessions,
      permissionCount,
      activeCriticalAlerts,
      latestFullBackup,
      latestRestoreDrill,
      latestAuditExport,
    ] = await Promise.all([
      safeQuery('active_admins', () => prisma.adminUser.count({ where: { status: 'active' } })),
      safeQuery('active_super_admins', () => prisma.adminUser.count({
        where: {
          status: 'active',
          roles: { some: { role: { code: 'super_admin', status: 'active' } } },
        },
      })),
      safeQuery('active_low_privilege_admins', () => prisma.adminUser.count({
        where: {
          status: 'active',
          roles: { none: { role: { code: 'super_admin', status: 'active' } } },
        },
      })),
      safeQuery('task84_accounts', () => prisma.adminUser.findMany({
        where: { username: { startsWith: 'task84_permission_smoke' } },
        select: {
          status: true,
          sessions: {
            where: { revokedAt: null, expiresAt: { gt: now } },
            select: { id: true },
          },
        },
      })),
      safeQuery('active_sessions', () => prisma.adminSession.count({ where: { revokedAt: null, expiresAt: { gt: now } } })),
      safeQuery('permissions', () => prisma.permission.count()),
      safeQuery('active_critical_alerts', () => prisma.alert.count({ where: { status: 'active', severity: 'critical' } })),
      safeQuery('latest_full_backup', () => prisma.backupRecord.findFirst({
        where: { status: 'succeeded', backupType: 'full' },
        orderBy: [{ completedAt: 'desc' }, { startedAt: 'desc' }],
        select: { status: true, backupType: true, completedAt: true, startedAt: true, encrypted: true },
      })),
      safeQuery('latest_restore_drill', () => prisma.restoreDrillRecord.findFirst({
        where: { status: 'succeeded' },
        orderBy: [{ completedAt: 'desc' }, { startedAt: 'desc' }],
        select: { status: true, completedAt: true, startedAt: true },
      })),
      safeQuery('latest_audit_export', () => prisma.auditLog.findFirst({
        where: { action: 'audit_logs.exported', result: 'success' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })),
    ]);

    const task84Disabled = task84Accounts.filter((item) => item.status === 'disabled').length;
    const task84Active = task84Accounts.filter((item) => item.status === 'active').length;
    const task84ActiveSessions = task84Accounts.reduce((sum, item) => sum + item.sessions.length, 0);
    const backupAt = latestFullBackup?.completedAt ?? latestFullBackup?.startedAt ?? null;
    const drillAt = latestRestoreDrill?.completedAt ?? latestRestoreDrill?.startedAt ?? null;

    console.log(`ACTIVE_ADMIN_USERS=${activeAdmins}`);
    console.log(`ACTIVE_SUPER_ADMIN_USERS=${activeSuperAdmins}`);
    console.log(`ACTIVE_LOW_PRIVILEGE_ADMIN_USERS=${activeLowPrivilegeAdmins}`);
    console.log(`TASK84_TEMP_ACCOUNT_MATCHES=${task84Accounts.length}`);
    console.log(`TASK84_TEMP_ACCOUNT_DISABLED=${task84Disabled}`);
    console.log(`TASK84_TEMP_ACCOUNT_ACTIVE=${task84Active}`);
    console.log(`TASK84_TEMP_ACCOUNT_ACTIVE_SESSIONS=${task84ActiveSessions}`);
    console.log(`ACTIVE_ADMIN_SESSIONS=${activeSessions}`);
    console.log(`PERMISSIONS=${permissionCount}`);
    console.log(`ACTIVE_CRITICAL_ALERTS=${activeCriticalAlerts}`);
    console.log(`LATEST_FULL_BACKUP_STATUS=${latestFullBackup?.status ?? 'missing'}`);
    console.log(`LATEST_FULL_BACKUP_TYPE=${latestFullBackup?.backupType ?? 'missing'}`);
    console.log(`LATEST_FULL_BACKUP_AT=${iso(backupAt)}`);
    console.log(`LATEST_FULL_BACKUP_AGE_HOURS=${ageHours(backupAt, now)}`);
    console.log(`LATEST_FULL_BACKUP_ENCRYPTED=${latestFullBackup?.encrypted ?? false}`);
    console.log(`LATEST_RESTORE_DRILL_STATUS=${latestRestoreDrill?.status ?? 'missing'}`);
    console.log(`LATEST_RESTORE_DRILL_AT=${iso(drillAt)}`);
    console.log(`LATEST_RESTORE_DRILL_AGE_DAYS=${ageDays(drillAt, now)}`);
    console.log(`LATEST_AUDIT_EXPORT_SUCCESS_AT=${iso(latestAuditExport?.createdAt ?? null)}`);

    const accountPass = activeAdmins === 1
      && activeSuperAdmins === 1
      && activeLowPrivilegeAdmins === 0
      && task84Accounts.length >= 1
      && task84Active === 0
      && task84Disabled === task84Accounts.length
      && task84ActiveSessions === 0
      && permissionCount === 37;
    const backupPass = latestFullBackup?.status === 'succeeded'
      && latestFullBackup.backupType === 'full'
      && ageHours(backupAt, now) <= 72;
    const drillPass = latestRestoreDrill?.status === 'succeeded'
      && ageDays(drillAt, now) <= 90;
    console.log(`ACCOUNT_PERMISSION_CLOSURE=${accountPass ? 'pass' : 'fail'}`);
    console.log(`BACKUP_WITHIN_72H=${backupPass ? 'pass' : 'fail'}`);
    console.log(`RESTORE_DRILL_WITHIN_90D=${drillPass ? 'pass' : 'fail'}`);
    console.log(`DATABASE_SUMMARY=${accountPass && backupPass && drillPass && activeCriticalAlerts === 0 ? 'pass' : 'fail'}`);
    if (!accountPass || !backupPass || !drillPass || activeCriticalAlerts !== 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

function gateSummary(path) {
  const result = readJson(path);
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const codes = (severity, status) => checks
    .filter((check) => check.severity === severity && check.status === status)
    .map((check) => check.code)
    .sort();
  const check = (code) => checks.find((item) => item.code === code);
  const detail = (code, key, fallback = 'unknown') => {
    const value = check(code)?.safeDetails?.[key];
    return value === undefined || value === null ? fallback : String(value);
  };

  console.log(`RELEASE_GATE_STATUS=${result.status ?? 'unknown'}`);
  console.log(`RELEASE_GATE_GENERATED_AT=${result.generatedAt ?? 'unknown'}`);
  console.log(`RELEASE_GATE_PASS=${result.summary?.pass ?? 'unknown'}`);
  console.log(`RELEASE_GATE_WARNING=${result.summary?.warning ?? 'unknown'}`);
  console.log(`RELEASE_GATE_FAIL=${result.summary?.fail ?? 'unknown'}`);
  console.log(`REQUIRED_FAIL_CODES=${codes('required', 'fail').join(',') || 'none'}`);
  console.log(`REQUIRED_WARNING_CODES=${codes('required', 'warning').join(',') || 'none'}`);
  console.log(`RECOMMENDED_WARNING_CODES=${codes('recommended', 'warning').join(',') || 'none'}`);
  console.log(`SYSTEM_HEALTH_GATE=${check('SYSTEM_HEALTH_NOT_CRITICAL')?.status ?? 'unknown'}`);
  console.log(`SYSTEM_HEALTH_STATUS=${detail('SYSTEM_HEALTH_NOT_CRITICAL', 'systemHealthStatus')}`);
  console.log(`BACKUP_HEALTH_GATE=${check('BACKUP_HEALTH_NOT_CRITICAL')?.status ?? 'unknown'}`);
  console.log(`BACKUP_HEALTH_STATUS=${detail('BACKUP_HEALTH_NOT_CRITICAL', 'backupHealthStatus')}`);
  console.log(`ACTIVE_CRITICAL_ALERTS_GATE=${check('ACTIVE_CRITICAL_ALERTS_ZERO')?.status ?? 'unknown'}`);
  console.log(`ACTIVE_CRITICAL_ALERT_COUNT=${detail('ACTIVE_CRITICAL_ALERTS_ZERO', 'activeCriticalAlertCount')}`);
  console.log(`BACKUP_72H_GATE=${check('RECENT_FULL_BACKUP_WITHIN_72H')?.status ?? 'unknown'}`);
  console.log(`BACKUP_AGE_HOURS=${detail('RECENT_FULL_BACKUP_WITHIN_72H', 'backupAgeHours')}`);
  console.log(`RESTORE_90D_GATE=${check('RECENT_RESTORE_DRILL_WITHIN_90D')?.status ?? 'unknown'}`);
  console.log(`RESTORE_DRILL_AGE_DAYS=${detail('RECENT_RESTORE_DRILL_WITHIN_90D', 'restoreDrillAgeDays')}`);
  console.log(`ENV_EVIDENCE_GATE=${check('ENV_CHECK_AVAILABLE')?.status ?? 'unknown'}`);
  console.log(`MIGRATION_EVIDENCE_GATE=${check('MIGRATIONS_UP_TO_DATE')?.status ?? 'unknown'}`);
  console.log(`E2E_PERMISSION_EVIDENCE_GATE=${check('E2E_PERMISSIONS_RECENT_RUN')?.status ?? 'unknown'}`);
}

function buildLogin(target) {
  const input = readFileSync(0);
  const first = input.indexOf(0);
  const last = input.lastIndexOf(0);
  if (first < 1 || last <= first) fail('invalid_login_input');
  const username = input.subarray(0, first).toString('utf8');
  const password = input.subarray(first + 1, last).toString('utf8');
  writeFileSync(target, `${JSON.stringify({ username, password })}\n`, { mode: 0o600 });
}

function inspectLogin(source, tokenPath) {
  const result = readJson(source);
  const actor = result.actor ?? {};
  const permissions = Array.isArray(actor.permissions) ? actor.permissions : [];
  const required = ['audit_log.view', 'audit_log.export'];
  if (typeof result.token !== 'string'
    || result.token.length < 32
    || actor.roleCode !== 'super_admin'
    || required.some((permission) => !permissions.includes(permission))) {
    fail('administrator_permission_chain_failed');
  }
  writeFileSync(tokenPath, result.token, { mode: 0o600 });
  console.log('TASK85_ADMIN_LOGIN=pass');
  console.log('TASK85_ADMIN_ROLE=super_admin');
  console.log(`TASK85_ADMIN_PERMISSION_COUNT=${permissions.length}`);
}

function auditCsv(path) {
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8');
  const rows = text.split(/\r?\n/).filter((line) => line.length > 0);
  const sensitive = /(postgres(?:ql)?:\/\/|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|Authorization:\s*Bearer|Set-Cookie:|DATABASE_URL\s*=)/i.test(text);
  const exportedCount = Math.max(0, rows.length - 1);
  console.log(`TASK85_AUDIT_EXPORTED_COUNT=${exportedCount}`);
  console.log(`TASK85_AUDIT_CSV_BYTES=${bytes.length}`);
  console.log(`TASK85_AUDIT_SENSITIVE_LEAK=${sensitive}`);
  if (bytes.length === 0 || exportedCount < 1 || sensitive) process.exit(1);
}

if (command === 'db-summary') {
  databaseSummary().catch(() => fail('database_summary_failed'));
} else if (command === 'gate-summary') {
  gateSummary(process.argv[3]);
} else if (command === 'build-login') {
  buildLogin(process.argv[3]);
} else if (command === 'inspect-login') {
  inspectLogin(process.argv[3], process.argv[4]);
} else if (command === 'audit-csv') {
  auditCsv(process.argv[3]);
} else {
  fail('unknown_command');
}
