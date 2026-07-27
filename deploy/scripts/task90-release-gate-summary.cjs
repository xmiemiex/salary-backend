'use strict';

const { readFileSync } = require('node:fs');

const path = process.argv[2];
if (!path) {
  console.error('RELEASE_GATE_SUMMARY_ERROR=missing_input');
  process.exit(2);
}

let result;
try {
  result = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  console.error('RELEASE_GATE_SUMMARY_ERROR=invalid_json');
  process.exit(2);
}

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
console.log(`BACKUP_72H_GATE=${check('RECENT_FULL_BACKUP_WITHIN_72H')?.status ?? 'unknown'}`);
console.log(`BACKUP_AGE_HOURS=${detail('RECENT_FULL_BACKUP_WITHIN_72H', 'backupAgeHours')}`);
console.log(`RESTORE_90D_GATE=${check('RECENT_RESTORE_DRILL_WITHIN_90D')?.status ?? 'unknown'}`);
console.log(`RESTORE_DRILL_AGE_DAYS=${detail('RECENT_RESTORE_DRILL_WITHIN_90D', 'restoreDrillAgeDays')}`);
console.log(`BACKUP_HEALTH_GATE=${check('BACKUP_HEALTH_NOT_CRITICAL')?.status ?? 'unknown'}`);
console.log(`BACKUP_HEALTH_STATUS=${detail('BACKUP_HEALTH_NOT_CRITICAL', 'backupHealthStatus')}`);
console.log(`SYSTEM_HEALTH_GATE=${check('SYSTEM_HEALTH_NOT_CRITICAL')?.status ?? 'unknown'}`);
console.log(`SYSTEM_HEALTH_STATUS=${detail('SYSTEM_HEALTH_NOT_CRITICAL', 'systemHealthStatus')}`);
console.log(`ACTIVE_CRITICAL_ALERTS_GATE=${check('ACTIVE_CRITICAL_ALERTS_ZERO')?.status ?? 'unknown'}`);
console.log(`ACTIVE_CRITICAL_ALERT_COUNT=${detail('ACTIVE_CRITICAL_ALERTS_ZERO', 'activeCriticalAlertCount')}`);
