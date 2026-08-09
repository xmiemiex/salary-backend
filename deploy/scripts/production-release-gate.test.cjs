'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

const scriptsDir = __dirname;
const envCheck = resolve(scriptsDir, 'production-env-check.js');
const gateScript = resolve(scriptsDir, 'production-release-gate.sh');
const permissionsScript = resolve(scriptsDir, 'production-permissions-smoke.sh');
const task96RolloutScript = resolve(scriptsDir, 'task96-production-rollout.sh');

function validProductionEnv() {
  return {
    ...process.env,
    NODE_ENV: 'production',
    APP_ENV: 'production',
    API_PORT: '3000',
    PORT: '3000',
    DATABASE_URL: 'postgresql://salary_app:01234567890123456789@host.docker.internal:5432/salary_settlement_prod?schema=public&sslmode=require',
    CORS_ALLOWED_ORIGIN: 'https://admin-salary.lovemiemie.com',
    ADMIN_SESSION_TTL_SECONDS: '3600',
    API_CREDENTIAL_ENCRYPTION_KEY: '01234567890123456789012345678901',
    BUILD_TIMESTAMP: '2026-07-28T00:00:00Z',
    RELEASE_IMAGE_TAG: 'rc-20260712-2',
    VITE_API_BASE_URL: 'https://api-salary.lovemiemie.com',
    PRODUCTION_ENV_FILE: '/opt/salary-settlement-admin/shared/.env',
    SYNC_PLANNER_ENABLED: 'false',
    SYNC_PLANNER_DAY: '10',
    SYNC_PLANNER_HOUR: '9',
    SYNC_PLANNER_TIMEZONE: 'Asia/Shanghai',
    SYNC_AUTO_EXECUTION_ENABLED: 'false',
    SYNC_AUTO_EXECUTION_POLL_SECONDS: '60',
    SYNC_AUTO_EXECUTION_BATCH_SIZE: '2',
    SYNC_AUTO_EXECUTION_MAX_ATTEMPTS: '3',
    SYNC_AUTO_EXECUTION_LEASE_SECONDS: '900',
    SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS: '300',
  };
}

test('production env check writes fresh redacted pass evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'salary-env-evidence-'));
  const evidencePath = join(directory, 'env-check.json');
  try {
    const output = execFileSync(process.execPath, [envCheck, evidencePath], {
      env: validProductionEnv(),
      encoding: 'utf8',
    });
    const evidenceText = readFileSync(evidencePath, 'utf8');
    const evidence = JSON.parse(evidenceText);
    assert.match(output, /ENV_CHECK_SUMMARY status=pass checked=23 failed=0/);
    assert.equal(evidence.type, 'env-check');
    assert.equal(evidence.status, 'pass');
    assert.equal(evidence.checkedVariables, 23);
    assert.deepEqual(evidence.invalid, []);
    assert.equal(evidence.checks.length, 23);
    assert.doesNotMatch(evidenceText, /01234567890123456789/);
    assert.doesNotMatch(evidenceText, /salary_settlement_prod/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production env check preserves a real failure in evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'salary-env-evidence-'));
  const evidencePath = join(directory, 'env-check.json');
  try {
    const environment = validProductionEnv();
    environment.RELEASE_IMAGE_TAG = 'wrong-release';
    const result = spawnSync(process.execPath, [envCheck, evidencePath], {
      env: environment,
      encoding: 'utf8',
    });
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.equal(result.status, 1);
    assert.equal(evidence.status, 'fail');
    assert.deepEqual(evidence.invalid, ['RELEASE_IMAGE_TAG']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production env check accepts the immutable task96 release format', () => {
  const environment = validProductionEnv();
  environment.RELEASE_IMAGE_TAG = 'task96-0123456789ab';
  const result = spawnSync(process.execPath, [envCheck], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ENV_CHECK name=RELEASE_IMAGE_TAG status=pass/);
});

test('production env check accepts the immutable task97 release format', () => {
  const environment = validProductionEnv();
  environment.RELEASE_IMAGE_TAG = 'task97-0123456789ab';
  const result = spawnSync(process.execPath, [envCheck], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ENV_CHECK name=RELEASE_IMAGE_TAG status=pass/);
});

test('standard gate refreshes read-only evidence and mounts it into the gate', () => {
  const script = readFileSync(gateScript, 'utf8');
  assert.match(script, /release-gate-current/);
  assert.match(script, /task96-\[0-9a-f\]/);
  assert.match(script, /task97-\[0-9a-f\]/);
  assert.match(script, /api_image="salary-settlement-api:\$\{release_tag\}"/);
  assert.match(script, /production-env-check\.js/);
  assert.match(script, /production-migration-evidence\.js/);
  assert.match(script, /docker run --rm \\\n  --user 0:0 \\\n  --env-file "\$prod_env"/);
  assert.match(script, /src=\$evidence_dir,dst=\/app\/tmp\/release-evidence,readonly/);
  assert.match(script, /src=\$release_dir\/prisma,dst=\/app\/prisma,readonly/);
  assert.doesNotMatch(script, /prisma migrate deploy/);
  assert.doesNotMatch(script, /docker compose (up|restart|down)/);
  assert.doesNotMatch(script, /systemctl restart/);
});

test('production permissions smoke only reuses the approved account and role', () => {
  const script = readFileSync(permissionsScript, 'utf8');
  assert.match(script, /select-minimal-role/);
  assert.match(script, /select-disabled-user/);
  assert.match(script, /LOW_PRIV_RELEASE_GATE_RUN_403/);
  assert.match(script, /LOW_PRIV_ADMIN_ONLY_403/);
  assert.match(script, /auth\/logout-all/);
  assert.match(script, /admin-users\/\$\(</);
  assert.doesNotMatch(script, /-X POST[\s\S]{0,200}http:\/\/127\.0\.0\.1:3000\/roles\s/);
  assert.doesNotMatch(script, /-X POST[\s\S]{0,200}http:\/\/127\.0\.0\.1:3000\/admin-users\s/);
  assert.doesNotMatch(script, /-X PATCH/);
});

test('task96 rollout is scoped to API/web and preserves database and nginx boundaries', () => {
  const script = readFileSync(task96RolloutScript, 'utf8');
  assert.match(script, /SCHEMA_AND_MIGRATIONS=unchanged/);
  assert.match(script, /diff -qr .*prisma\/migrations/);
  assert.match(script, /up -d --no-build --no-deps api web/);
  assert.match(script, /AUTOMATIC_ROLLBACK=triggered/);
  assert.match(script, /ILLEGAL_PLATFORM_HTTP=\$\{illegal_code\}/);
  assert.match(script, /nginx-target-before\.txt/);
  assert.match(script, /nginx-target-after\.txt/);
  assert.doesNotMatch(script, /prisma migrate|db:migrate|migrate deploy/i);
  assert.doesNotMatch(script, /docker compose (down|restart)/);
  assert.doesNotMatch(script, /systemctl|service (postgres|nginx)|nginx -s/i);
  assert.doesNotMatch(script, /--remove-orphans/);
});
