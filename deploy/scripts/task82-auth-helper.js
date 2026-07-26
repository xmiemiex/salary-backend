'use strict';

const { readFileSync, writeFileSync } = require('node:fs');

const command = process.argv[2];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
}

if (command === 'build-login') {
  const target = process.argv[3];
  const input = readFileSync(0);
  const separator = input.indexOf(0);
  const username = input.subarray(0, separator).toString('utf8');
  const password = input.subarray(separator + 1, input.lastIndexOf(0)).toString('utf8');
  writeJson(target, { username, password });
} else if (command === 'inspect-login') {
  const source = process.argv[3];
  const tokenPath = process.argv[4];
  const evidencePath = process.argv[5];
  const result = readJson(source);
  const actor = result.actor ?? {};
  const permissions = Array.isArray(actor.permissions) ? actor.permissions : [];
  const required = [
    'release_gate.read',
    'release_gate.run',
    'audit_log.view',
    'audit_log.export',
    'system_health.read',
    'backup_status.read',
    'restore_drill.read',
    'alerts.read',
  ];
  const missing = required.filter((permission) => !permissions.includes(permission));
  const superAdminPass = actor.roleCode === 'super_admin' && missing.length === 0;
  if (typeof result.token !== 'string' || result.token.length < 32 || !superAdminPass) {
    throw new Error('login actor failed the super_admin permission-chain check');
  }
  writeFileSync(tokenPath, result.token, { mode: 0o600 });
  const now = new Date().toISOString();
  writeJson(evidencePath, {
    schemaVersion: 1,
    type: 'e2e-permissions',
    command: 'production-equivalent existing-admin permission smoke',
    startedAt: now,
    finishedAt: now,
    status: 'fail',
    checksTotal: 3,
    passed: 2,
    failed: 0,
    cleanup: 'not_applicable_no_fixture_or_account_created',
    mode: 'production-equivalent-existing-admin',
    summary: {
      superAdminPermissionChain: superAdminPass ? 'pass' : 'fail',
      unauthenticated401: 'pass',
      lowPrivilege403: 'pending_no_approved_low_privilege_account',
      newAdminAccountsCreated: 0,
      overall: 'pending',
      missingRequiredPermissions: missing,
    },
  });
  console.log('TASK82_ADMIN_LOGIN=pass');
  console.log(`TASK82_ADMIN_ROLE=${actor.roleCode}`);
  console.log(`TASK82_ADMIN_PERMISSION_COUNT=${permissions.length}`);
  console.log('TASK82_E2E_EQUIVALENT=pending reason=low_privilege_403_unavailable');
} else if (command === 'summarize-api') {
  const systemHealth = readJson(process.argv[3]);
  const backupHealth = readJson(process.argv[4]);
  const alerts = readJson(process.argv[5]);
  const criticalChecks = Array.isArray(systemHealth.checks)
    ? systemHealth.checks.filter((check) => check.status === 'critical').length
    : 0;
  const activeCritical = Number(alerts.total ?? 0);
  console.log(`TASK82_SYSTEM_HEALTH=${systemHealth.status ?? 'unknown'}`);
  console.log(`TASK82_SYSTEM_CRITICAL_CHECKS=${criticalChecks}`);
  console.log(`TASK82_BACKUP_HEALTH=${backupHealth.status ?? 'unknown'}`);
  console.log(`TASK82_ACTIVE_CRITICAL_ALERTS=${activeCritical}`);
  if (systemHealth.status === 'critical' || backupHealth.status === 'critical' || activeCritical > 0) {
    process.exit(1);
  }
} else if (command === 'audit-csv') {
  const path = process.argv[3];
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8');
  const rows = text.split(/\r?\n/).filter((line) => line.length > 0);
  const sensitive = /(DATABASE_URL|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|Authorization:\s*Bearer|Set-Cookie:)/i.test(text);
  const exportedCount = Math.max(0, rows.length - 1);
  console.log(`TASK82_AUDIT_EXPORTED_COUNT=${exportedCount}`);
  console.log(`TASK82_AUDIT_CSV_BYTES=${bytes.length}`);
  console.log(`TASK82_AUDIT_SENSITIVE_LEAK=${sensitive}`);
  if (bytes.length === 0 || exportedCount < 1 || sensitive) process.exit(1);
} else if (command === 'stale-session-ids') {
  const source = process.argv[3];
  const target = process.argv[4];
  const start = new Date(process.argv[5]).getTime();
  const end = new Date(process.argv[6]).getTime();
  const sessions = readJson(source);
  const ids = Array.isArray(sessions)
    ? sessions
      .filter((session) => {
        const createdAt = new Date(session.createdAt).getTime();
        return session.isCurrent === false
          && (
            /^task82-smoke\//i.test(session.userAgent ?? '')
            || (
              /^curl\//i.test(session.userAgent ?? '')
              && createdAt >= start
              && createdAt <= end
            )
          );
      })
      .map((session) => session.id)
      .filter((id) => typeof id === 'string')
    : [];
  writeFileSync(target, ids.length > 0 ? `${ids.join('\n')}\n` : '', { mode: 0o600 });
  console.log(`TASK82_STALE_SESSION_MATCHES=${ids.length}`);
} else {
  console.error('TASK82_AUTH_HELPER_ERROR=unknown_command');
  process.exit(2);
}
