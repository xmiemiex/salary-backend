import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildAdminUsersQuery,
  buildCreateAdminUserPayload,
  canManageAdminUsers,
  canReadAdminUsers,
  containsSensitiveAdminField,
  validatePasswordConfirmation,
} from '../src/pages/admin-user-utils';

const reader = { userId: 'reader', roleCode: 'reader', permissions: ['admin_users.read'] };
assert.equal(canReadAdminUsers(reader), true);
assert.equal(canManageAdminUsers(reader), false);
assert.equal(canManageAdminUsers({ ...reader, permissions: ['admin_users.manage'] }), true);

assert.equal(buildAdminUsersQuery({ page: 2, pageSize: 50, search: ' admin ', status: 'active', roleId: 'role' }), 'page=2&pageSize=50&search=admin&status=active&roleId=role');
assert.match(validatePasswordConfirmation('short', 'short') ?? '', /12-256/);
assert.match(validatePasswordConfirmation('StrongPassword123', 'different') ?? '', /不一致/);
assert.equal(validatePasswordConfirmation('StrongPassword123', 'StrongPassword123'), null);
assert.equal(containsSensitiveAdminField({ items: [{ id: '1', passwordHash: 'x' }] }), true);
assert.equal(containsSensitiveAdminField({ items: [{ id: '1', username: 'safe' }] }), false);
assert.deepEqual(buildCreateAdminUserPayload({
  username: 'new-admin', email: 'new@test.invalid', password: 'StrongPassword123', confirmPassword: 'StrongPassword123', roleIds: ['new-role-id'], status: 'active',
}), { username: 'new-admin', email: 'new@test.invalid', password: 'StrongPassword123', roleIds: ['new-role-id'], status: 'active' });

const page = readFileSync(new URL('../src/pages/AdminUsersPage.tsx', import.meta.url), 'utf8');
assert.equal(page.includes('<Input.Password'), true, 'password controls must be masked');
assert.equal(page.includes('modalApi.confirm'), true, 'dangerous actions must require confirmation');
assert.equal(page.includes("record.id === actor.userId"), true, 'self-disable must be disabled in UI');
assert.equal(page.includes('passwordHash'), false, 'page must not render password hashes');
assert.equal(page.includes('tokenHash'), false, 'page must not render session token hashes');
assert.equal(page.includes("method: 'PATCH'"), true, 'edit request must be implemented');
assert.equal(page.includes("method: 'POST'"), true, 'create/reset/disable requests must be implemented');
assert.equal(page.includes('buildCreateAdminUserPayload(values)'), true, 'create form must submit selected roleIds');
assert.equal(page.includes('请修正创建表单中的校验错误。'), true, 'validation failures must be visible');
assert.equal(page.includes('afterOpenChange={(open) => { if (!open) return; editorForm'), false, 'editor animation must not reset values after input begins');
assert.equal(page.includes('if (!editorOpen) return;'), true, 'editor must initialize after fields mount');

console.log('admin-user-utils tests passed');
