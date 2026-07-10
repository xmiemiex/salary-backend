import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getVisibleMenu } from '../src/layout/AdminLayout';
import {
  containsSensitiveSystemHealthField,
  safeDisplayValue,
  sortChecks,
  statusColor,
  statusLabel,
} from '../src/pages/system-health-utils';

assert.equal(statusLabel('ok'), 'OK');
assert.equal(statusLabel('warning'), 'Warning');
assert.equal(statusLabel('critical'), 'Critical');
assert.equal(statusColor('critical'), 'red');
assert.deepEqual(sortChecks([
  { code: 'B', status: 'ok', title: 'b', message: 'b', updatedAt: '1' },
  { code: 'A', status: 'critical', title: 'a', message: 'a', updatedAt: '1' },
  { code: 'C', status: 'warning', title: 'c', message: 'c', updatedAt: '1' },
]).map((item) => item.code), ['A', 'C', 'B']);
assert.equal(safeDisplayValue(true), '是');
assert.equal(safeDisplayValue(false), '否');
assert.equal(containsSensitiveSystemHealthField({ database: { connected: true } }), false);
assert.equal(containsSensitiveSystemHealthField({ DATABASE_URL: 'postgres://x' }), true);
assert.equal(containsSensitiveSystemHealthField({ leaseOwner: 'worker' }), true);
assert.equal(containsSensitiveSystemHealthField({ nested: { token: 'abc' } }), true);

const highMenu = getVisibleMenu({ userId: 'u', roleCode: 'r', permissions: ['system_health.read'] });
assert.equal(highMenu.some((item) => item.path === '/system-health'), true);
const lowMenu = getVisibleMenu({ userId: 'u', roleCode: 'r', permissions: ['salary.view_self'] });
assert.equal(lowMenu.some((item) => item.path === '/system-health'), false);

const page = readFileSync(new URL('../src/pages/SystemHealthPage.tsx', import.meta.url), 'utf8');
assert.match(page, /\/system-health/);
assert.match(page, /总体健康摘要/);
assert.match(page, /数据库与迁移/);
assert.match(page, /同步规划状态/);
assert.match(page, /自动执行状态/);
assert.match(page, /provider 凭证完整性/);
assert.match(page, /最近异常事件/);
assert.match(page, /刷新/);
assert.match(page, /containsSensitiveSystemHealthField/);
assert.doesNotMatch(page, /dangerouslySetInnerHTML|setInterval|DATABASE_URL|leaseOwner|tokenHash|passwordHash|encryptedPayload/);

console.log('system health page tests passed');
