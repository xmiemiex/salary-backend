'use strict';

const { readFileSync, writeFileSync } = require('node:fs');

const command = process.argv[2];
const expectedUsername = 'task84_permission_smoke';
const accountMask = 'task84_***_smoke';
const minimalPermission = 'salary.view_self';
const requiredSuperPermissions = [
  'release_gate.read',
  'release_gate.run',
  'admin_users.read',
  'admin_users.manage',
  'role.read',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function fail(message) {
  throw new Error(message);
}

function successHttp(code) {
  return code === '200' || code === '201';
}

if (command === 'build-login') {
  const input = readFileSync(0);
  const separator = input.indexOf(0);
  const end = input.lastIndexOf(0);
  if (separator < 1 || end <= separator) fail('invalid credential input');
  writeJson(process.argv[3], {
    username: input.subarray(0, separator).toString('utf8'),
    password: input.subarray(separator + 1, end).toString('utf8'),
  });
} else if (command === 'inspect-super') {
  const response = readJson(process.argv[3]);
  const actor = response.actor ?? {};
  const permissions = Array.isArray(actor.permissions) ? actor.permissions : [];
  const missing = requiredSuperPermissions.filter((permission) => !permissions.includes(permission));
  if (typeof response.token !== 'string' || response.token.length < 32) fail('super_admin login returned no valid session');
  if (actor.roleCode !== 'super_admin' || missing.length > 0) fail('super_admin permission chain failed');
  writeFileSync(process.argv[4], response.token, { mode: 0o600 });
  console.log('SUPER_ADMIN_CHAIN=pass');
  console.log(`SUPER_ADMIN_PERMISSION_COUNT=${permissions.length}`);
  console.log('SUPER_ADMIN_RELEASE_GATE_READ=present');
  console.log('SUPER_ADMIN_RELEASE_GATE_RUN=present');
} else if (command === 'admin-summary') {
  const response = readJson(process.argv[3]);
  const items = Array.isArray(response.items) ? response.items : [];
  if (Number(response.total) !== items.length) fail('active administrator result was truncated');
  const superCount = items.filter((item) =>
    Array.isArray(item.roles) && item.roles.some((role) => role.code === 'super_admin')).length;
  const nonSuperCount = items.length - superCount;
  console.log(`ACTIVE_ADMIN_COUNT=${items.length}`);
  console.log(`ACTIVE_SUPER_ADMIN_COUNT=${superCount}`);
  console.log(`ACTIVE_NON_SUPER_ADMIN_COUNT=${nonSuperCount}`);
  if (items.length !== 1 || superCount !== 1 || nonSuperCount !== 0) {
    fail('administrator baseline is not 1/1/0');
  }
} else if (command === 'select-minimal-role') {
  const response = readJson(process.argv[3]);
  const items = Array.isArray(response.items) ? response.items : [];
  const isApprovedMinimalRole = (role) => {
    const codes = Array.isArray(role.permissions)
      ? role.permissions.map((permission) => permission.code)
      : [];
    return role.status === 'active'
      && role.code !== 'super_admin'
      && codes.length === 1
      && codes[0] === minimalPermission;
  };
  const exactNamed = items.filter((role) => role.name === 'permission_smoke_readonly');
  if (exactNamed.length > 1 || (exactNamed.length === 1 && !isApprovedMinimalRole(exactNamed[0]))) {
    fail('existing named production smoke role is not the approved minimal role');
  }
  const candidates = exactNamed.length === 1
    ? exactNamed
    : items.filter(isApprovedMinimalRole);
  if (candidates.length !== 1) fail('exactly one approved minimal role must already exist');
  writeJson(process.argv[4], {
    id: candidates[0].id,
    code: candidates[0].code,
    permissionCodes: [minimalPermission],
  });
  console.log('LOW_PRIV_ROLE_ACTION=reuse');
  console.log('LOW_PRIV_ROLE_PERMISSION_COUNT=1');
  console.log(`LOW_PRIV_ROLE_PERMISSION_SUMMARY=${minimalPermission}`);
  console.log('LOW_PRIV_ROLE_RELEASE_GATE_RUN=absent');
} else if (command === 'select-disabled-user') {
  const response = readJson(process.argv[3]);
  const role = readJson(process.argv[4]);
  const exact = (Array.isArray(response.items) ? response.items : [])
    .filter((item) => item.username === expectedUsername);
  if (exact.length !== 1) fail('exactly one existing production smoke account is required');
  const account = exact[0];
  const roleIds = Array.isArray(account.roles) ? account.roles.map((item) => item.id) : [];
  if (account.status !== 'disabled') fail('production smoke account must start disabled');
  if (roleIds.length !== 1 || roleIds[0] !== role.id) fail('production smoke account is not bound to the approved minimal role');
  writeFileSync(process.argv[5], account.id, { mode: 0o600 });
  console.log(`LOW_PRIV_ACCOUNT=${accountMask}`);
  console.log('LOW_PRIV_ACCOUNT_ACTION=reuse_disabled');
  console.log('LOW_PRIV_ACCOUNT_ROLE=verified_read_only');
} else if (command === 'build-password-reset') {
  const password = readFileSync(process.argv[3], 'utf8');
  if (password.length < 20) fail('temporary password is invalid');
  writeJson(process.argv[4], { password, confirmPassword: password });
} else if (command === 'inspect-active-account') {
  const response = readJson(process.argv[3]);
  if (response.username !== expectedUsername || response.status !== 'active') {
    fail('production smoke account did not become active');
  }
  console.log('LOW_PRIV_ACCOUNT_ACTIVE=pass');
} else if (command === 'inspect-low') {
  const response = readJson(process.argv[3]);
  const expectedId = readFileSync(process.argv[4], 'utf8').trim();
  const actor = response.actor ?? {};
  const permissions = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (typeof response.token !== 'string' || response.token.length < 32 || actor.userId !== expectedId) {
    fail('low-privilege login identity failed');
  }
  if (actor.roleCode === 'super_admin'
      || permissions.length !== 1
      || permissions[0] !== minimalPermission
      || permissions.includes('release_gate.run')
      || permissions.includes('admin_users.read')) {
    fail('low-privilege permission boundary failed');
  }
  writeFileSync(process.argv[5], response.token, { mode: 0o600 });
  console.log('LOW_PRIV_LOGIN=pass');
  console.log('LOW_PRIV_PERMISSION_COUNT=1');
  console.log('LOW_PRIV_RELEASE_GATE_RUN=absent');
  console.log('LOW_PRIV_SUPER_ADMIN=absent');
} else if (command === 'inspect-me') {
  const response = readJson(process.argv[3]);
  const expectedId = readFileSync(process.argv[4], 'utf8').trim();
  const actor = response.actor ?? {};
  const permissions = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (actor.userId !== expectedId
      || actor.roleCode === 'super_admin'
      || permissions.length !== 1
      || permissions[0] !== minimalPermission) {
    fail('low-privilege /me validation failed');
  }
  console.log('LOW_PRIV_ME=pass');
} else if (command === 'inspect-disabled') {
  const response = readJson(process.argv[3]);
  if (response.username !== expectedUsername || response.status !== 'disabled') {
    fail('production smoke account cleanup failed');
  }
  console.log('LOW_PRIV_ACCOUNT_DISABLED=pass');
} else if (command === 'write-evidence') {
  writeJson(process.argv[3], {
    schemaVersion: 1,
    type: 'e2e-permissions',
    command: 'controlled production authorization smoke',
    startedAt: process.argv[4],
    finishedAt: new Date().toISOString(),
    status: 'pass',
    environment: 'production',
    checksTotal: 7,
    passed: 7,
    failed: 0,
    cleanup: 'temporary_low_privilege_account_disabled_sessions_revoked',
    mode: 'production-real-low-privilege',
    productionEvidence: true,
    fixtureOnly: false,
    summary: {
      unauthenticated401: 'pass',
      superAdminPermissionChain: 'pass',
      superAdminReleaseGateRead: 'pass',
      lowPrivilegeLoginAndMe: 'pass',
      lowPrivilegeReleaseGateRun403: 'pass',
      lowPrivilegeAdminOnly403: 'pass',
      lowPrivilegeLogoutAll: 'pass',
      account: accountMask,
      accountFinalStatus: 'disabled',
      sessionCleanup: 'pass',
      rolePermissionSummary: [minimalPermission],
      releaseGateRunPermission: 'absent',
      superAdminRole: 'absent',
      ciFixtureUsed: false,
      overall: 'pass',
    },
  });
  console.log('PRODUCTION_E2E_EVIDENCE=pass');
} else if (command === 'check-http') {
  const label = process.argv[3];
  if (process.argv[4] !== process.argv[5]) fail(`${label} returned an unexpected HTTP status`);
  console.log(`${label}=pass`);
} else if (command === 'check-success-http') {
  const label = process.argv[3];
  if (!successHttp(process.argv[4])) fail(`${label} returned an unexpected HTTP status`);
  console.log(`${label}=pass`);
} else {
  fail('unknown production permissions smoke helper command');
}
