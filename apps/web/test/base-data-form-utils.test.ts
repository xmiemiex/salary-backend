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
assert.match(page, /name: 'affiliateAccountId'.+type: 'select'.+optionSource: 'affiliateAccounts'/);
assert.match(page, /name: 'employeeId'.+type: 'select'.+optionSource: 'employees'/);
assert.match(page, /\['sub1', 'sub2', 'sub3', 'sub4', 'sub5'\]/);

console.log('base data form utility tests passed');
