import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getVisibleMenu } from '../src/layout/AdminLayout';
import { compactJson, containsSensitiveBackupField, statusColor, validateSafeInput } from '../src/pages/backup-recovery-utils';

assert.equal(statusColor('critical'), 'red');
assert.equal(statusColor('warning'), 'gold');
assert.equal(statusColor('ok'), 'green');
assert.equal(statusColor('succeeded'), 'green');
assert.equal(compactJson({ safe: true }), '{\n  "safe": true\n}');
assert.equal(containsSensitiveBackupField({ safe: 'value' }), false);
assert.equal(containsSensitiveBackupField({ token: 'abc' }), true);
assert.equal(containsSensitiveBackupField({ storage: 's3://bucket/file.dump' }), true);
assert.equal(validateSafeInput({ storageAlias: 'primary-offsite' }), null);
assert.match(validateSafeInput({ storageAlias: 'C:\\backup\\dump.sql' }) ?? '', /URL|绝对路径|敏感字段/);
assert.match(validateSafeInput({ safeMetadata: { password: 'x' } }) ?? '', /URL|绝对路径|敏感字段/);

const readMenu = getVisibleMenu({ userId: 'u', roleCode: 'r', permissions: ['backup_status.read'] });
assert.equal(readMenu.some((item) => item.path === '/backup-recovery'), true);
const drillReadMenu = getVisibleMenu({ userId: 'u', roleCode: 'r', permissions: ['restore_drill.read'] });
assert.equal(drillReadMenu.some((item) => item.path === '/backup-recovery'), true);
const lowMenu = getVisibleMenu({ userId: 'u', roleCode: 'r', permissions: ['salary.view_self'] });
assert.equal(lowMenu.some((item) => item.path === '/backup-recovery'), false);

const page = readFileSync(new URL('../src/pages/BackupRecoveryPage.tsx', import.meta.url), 'utf8');
assert.match(page, /\/backup-health/);
assert.match(page, /\/backup-records/);
assert.match(page, /\/restore-drills/);
assert.match(page, /数据保全 \/ 备份恢复/);
assert.match(page, /备份健康摘要/);
assert.match(page, /新增备份记录/);
assert.match(page, /新增恢复演练/);
assert.match(page, /containsSensitiveBackupField/);
assert.match(page, /validateSafeInput/);
assert.doesNotMatch(page, /dangerouslySetInnerHTML|DATABASE_URL|tokenHash|passwordHash|encryptedPayload|credentialPayload/);

const systemHealthPage = readFileSync(new URL('../src/pages/SystemHealthPage.tsx', import.meta.url), 'utf8');
assert.match(systemHealthPage, /dataProtection/);
assert.match(systemHealthPage, /数据保全/);

console.log('backup recovery page tests passed');
