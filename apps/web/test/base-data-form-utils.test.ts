import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildAffiliateAccountOptions,
  buildEmployeeOptions,
  normalizePayload,
} from '../src/pages/BaseDataPages';

assert.deepEqual(
  buildAffiliateAccountOptions([
    { id: 'cake-account', platform: 'cake', accountCode: '329', accountName: 'Blitzads', status: 'active' },
  ]),
  [{ value: 'cake-account', label: 'CAKE / Blitzads / 329' }],
);

assert.deepEqual(
  buildEmployeeOptions([
    { id: 'employee-zw', employeeCode: '01', name: 'ZW', status: 'active' },
    { id: 'employee-old', employeeCode: '99', name: 'Old', status: 'disabled' },
  ]),
  [
    { value: 'employee-zw', label: '01 / ZW' },
    { value: 'employee-old', label: '99 / Old（已禁用）' },
  ],
);

const emailField = [{ name: 'email', label: '邮箱', clearOnEmpty: true }];
assert.deepEqual(normalizePayload({ email: '' }, emailField, false), {});
assert.deepEqual(normalizePayload({ email: '' }, emailField, true), { email: '' });
assert.deepEqual(normalizePayload({ email: 'new@example.test' }, emailField, true), { email: 'new@example.test' });

const page = readFileSync(new URL('../src/pages/BaseDataPages.tsx', import.meta.url), 'utf8');
const photonpayGovernance = readFileSync(new URL('../src/pages/PhotonPayCardGovernancePanel.tsx', import.meta.url), 'utf8');
assert.match(page, /name: 'affiliateAccountId'.+type: 'select'.+optionSource: 'affiliateAccounts'/);
assert.match(page, /name: 'employeeId'.+type: 'select'.+optionSource: 'employees'/);
assert.match(page, /function ProviderCardsPage\(\)/);
assert.match(page, /\/card-bindings\/sync\/\$\{provider\}/);
const cardBindingConfig = page.match(/'\/card-bindings': \{([\s\S]*?)\r?\n  \},\r?\n  '\/monthly-exchange-rates'/)?.[1] ?? '';
assert.match(cardBindingConfig, /fields: \[\]/);
assert.doesNotMatch(cardBindingConfig, /name: '(?:cardId|employeeId|effectiveMonth)'/);
assert.doesNotMatch(page, /\/card-bindings\/airwallex\/discovery/);
assert.match(photonpayGovernance, /\/card-bindings\/photonpay\/unmatched-groups/);
assert.match(photonpayGovernance, /\/card-bindings\/photonpay\/aliases\/preview/);
assert.match(photonpayGovernance, /\/card-bindings\/photonpay\/employee-options/);
assert.match(photonpayGovernance, /aliases\/\$\{editingAlias\.id\}\/preview/);
assert.match(photonpayGovernance, /\/card-bindings\/photonpay\/exclusions\/preview/);
assert.match(photonpayGovernance, /确认保存并重新匹配/);
assert.match(photonpayGovernance, /已有 CardSpendEvent/);
assert.doesNotMatch(photonpayGovernance, /name="(?:cardId|providerCardId)"/);
assert.match(page, /\['sub1', 'sub2', 'sub3', 'sub4', 'sub5'\]/);
assert.match(page, /label: '生效月份（从本月起）'/);
assert.match(page, /映射从生效月份开始持续有效，后续月份无需重复创建；只有归属变化时才新增更晚月份的映射版本。/);

console.log('base data form utility tests passed');
