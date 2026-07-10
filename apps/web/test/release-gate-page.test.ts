import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getVisibleMenu } from '../src/layout/AdminLayout';
import {
  containsSensitiveReleaseGateField,
  groupReleaseGateChecks,
  releaseGateStatusColor,
  releaseGateStatusLabel,
  safeReleaseGateDetails,
  type ReleaseGateCheck,
} from '../src/pages/release-gate-utils';

const checks: ReleaseGateCheck[] = [
  { code: 'B', severity: 'required', status: 'pass', title: 'b', message: 'b', remediation: 'b' },
  { code: 'A', severity: 'required', status: 'fail', title: 'a', message: 'a', remediation: 'a' },
  { code: 'C', severity: 'recommended', status: 'warning', title: 'c', message: 'c', remediation: 'c' },
];

assert.equal(releaseGateStatusLabel('pass'), 'PASS');
assert.equal(releaseGateStatusLabel('warning'), 'WARNING');
assert.equal(releaseGateStatusLabel('fail'), 'FAIL');
assert.equal(releaseGateStatusColor('fail'), 'red');
assert.deepEqual(groupReleaseGateChecks(checks, 'required').map((item) => item.code), ['A', 'B']);
assert.equal(safeReleaseGateDetails({ count: 1 }), '{"count":1}');
assert.equal(containsSensitiveReleaseGateField({ safe: 'value' }), false);
assert.equal(containsSensitiveReleaseGateField({ passwordHash: 'x' }), true);
assert.equal(containsSensitiveReleaseGateField({ leaseOwner: 'worker' }), true);
assert.equal(containsSensitiveReleaseGateField({ url: 'https://user:pass@example.test/path' }), true);

const readMenu = getVisibleMenu({ userId: 'u', roleCode: 'r', permissions: ['release_gate.read'] });
assert.equal(readMenu.some((item) => item.path === '/release-gate'), true);
const lowMenu = getVisibleMenu({ userId: 'u', roleCode: 'r', permissions: ['salary.view_self'] });
assert.equal(lowMenu.some((item) => item.path === '/release-gate'), false);

const page = readFileSync(new URL('../src/pages/ReleaseGatePage.tsx', import.meta.url), 'utf8');
assert.match(page, /\/release-gate/);
assert.match(page, /\/release-gate\/run/);
assert.match(page, /发布门禁 \/ 上线检查/);
assert.match(page, /必须通过项/);
assert.match(page, /建议检查项/);
assert.match(page, /修复建议/);
assert.match(page, /release_gate\.run/);
assert.match(page, /ApiError|containsSensitiveReleaseGateField/);
assert.doesNotMatch(page, /dangerouslySetInnerHTML|DATABASE_URL|tokenHash|passwordHash|encryptedPayload|credentialPayload|leaseOwner/);

console.log('release gate page tests passed');
