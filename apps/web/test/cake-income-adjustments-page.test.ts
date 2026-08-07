import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ADMIN_MENU, isAdminMenuItemVisible } from '../src/navigation/menu';

const item = ADMIN_MENU.find((candidate) => candidate.path === '/cake-income-adjustments');
assert.ok(item, 'CAKE adjustment menu must exist');
assert.equal(isAdminMenuItemVisible(item, { roleCode: 'super_admin', permissions: ['income.import'] }), true);
assert.equal(isAdminMenuItemVisible(item, { roleCode: 'admin', permissions: ['income.import'] }), false);
assert.equal(isAdminMenuItemVisible(item, { roleCode: 'super_admin', permissions: [] }), false);

const source = readFileSync(fileURLToPath(new URL('../src/pages/CakeIncomeAdjustmentsPage.tsx', import.meta.url)), 'utf8');
for (const text of [
  'API默认时区基础 Revenue',
  'China Standard Time 实际 Revenue',
  '自动调整',
  '保存草稿',
  '确认调整',
  '停用调整',
  '刷新基础记录显示',
  '导出核对CSV',
  '基础已变化',
]) assert.match(source, new RegExp(text));

assert.doesNotMatch(source, /API(?:默认时区)?(?:基础)? Revenue就是China Standard Time/);

console.log('cake-income-adjustments-page tests passed');
