import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { containsSensitiveSecurityField, runInvalidatingAction, validatePasswordChange } from '../src/pages/security-utils';

async function main() {
  assert.match(validatePasswordChange({ currentPassword: 'Current123456', newPassword: 'short1', confirmPassword: 'short1' }) ?? '', /12-256/);
  assert.match(validatePasswordChange({ currentPassword: 'Current123456', newPassword: 'Replacement123', confirmPassword: 'Different1234' }) ?? '', /不一致/);
  assert.match(validatePasswordChange({ currentPassword: 'Current123456', newPassword: 'Current123456', confirmPassword: 'Current123456' }) ?? '', /不能/);
  assert.equal(validatePasswordChange({ currentPassword: 'Current123456', newPassword: 'Replacement123', confirmPassword: 'Replacement123' }), null);

  assert.equal(containsSensitiveSecurityField({ sessions: [{ id: 'safe' }] }), false);
  for (const field of ['passwordHash', 'tokenHash', 'token', 'authorization', 'cookie']) {
    assert.equal(containsSensitiveSecurityField({ nested: { [field]: 'secret' } }), true);
  }

  let cleared = false;
  await runInvalidatingAction(async () => ({ success: true }), () => { cleared = true; });
  assert.equal(cleared, true, 'successful password/logout-all interaction must clear the local session');
  cleared = false;
  await assert.rejects(runInvalidatingAction(async () => { throw new Error('failed'); }, () => { cleared = true; }));
  assert.equal(cleared, false, 'failed password change must keep a still-valid session');

  const page = readFileSync(new URL('../src/pages/SecurityPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /Modal\.useModal/);
  assert.match(page, /Input\.Password/);
  assert.match(page, /当前会话/);
  assert.match(page, /确认撤销/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  console.log('security page tests passed');
}

void main();
