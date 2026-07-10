import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canNavigateDashboardTarget, containsSensitiveDashboardField, currentGmt8Month, formatDashboardMoney, formatDashboardTime } from '../src/pages/dashboard-utils';

assert.equal(currentGmt8Month(new Date('2026-05-31T16:00:00.000Z')), '2026-06');
assert.equal(formatDashboardMoney('0.300000'), '$0.30');
assert.equal(formatDashboardMoney('1234.5', 'RMB'), '¥1,234.50');
assert.notEqual(formatDashboardTime('2026-06-01T00:00:00.000Z'), '—');
assert.equal(canNavigateDashboardTarget({ userId: 'u', roleCode: 'r', permissions: ['salary.view_all'] }, '/salary-settlements'), true);
assert.equal(canNavigateDashboardTarget({ userId: 'u', roleCode: 'r', permissions: ['salary.view_self'] }, '/salary-settlements'), false);
assert.equal(containsSensitiveDashboardField({ safe: 1, nested: { rawPayload: 'x' } }), true);
assert.equal(containsSensitiveDashboardField({ safe: 1 }), false);

const page = readFileSync(new URL('../src/pages/DashboardPage.tsx', import.meta.url), 'utf8');
assert.match(page, /DatePicker picker="month"/);
assert.match(page, /onChange={selectMonth}/);
assert.match(page, /loading={loading} onClick=/);
assert.match(page, /已保留上次成功数据/);
assert.match(page, /setData\(next\)/);
assert.doesNotMatch(page, /setInterval|dangerouslySetInnerHTML|rawPayload|passwordHash|tokenHash/);
assert.match(page, /onNavigate\(item\.targetPath\)/);
console.log('dashboard page interaction tests passed');
