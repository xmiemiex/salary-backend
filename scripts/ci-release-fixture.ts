import {
  AlertSeverity,
  AlertStatus,
  BackupStatus,
  BackupType,
  CommonStatus,
  PrismaClient,
  RestoreDrillStatus,
} from '@prisma/client';
import { PERMISSIONS } from '@salary/shared';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prisma = new PrismaClient();
const root = resolve(__dirname, '..');
const fixtureVersion = 'ci-release-fixture-v1';
const fixtureSource = 'github-actions-ci-release-fixture';
const adminUsername = 'ci_release_fixture_admin';
const adminEmail = 'ci-release-fixture@example.invalid';
const backupKey = 'ci-release-fixture-full-backup';
const drillKey = 'ci-release-fixture-restore-drill';
const auditFixtureId = '00000000-0000-4000-8000-000000000072';

function assertCiOnly(): void {
  if (process.env.CI !== 'true') throw new Error('CI=true is required.');
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('GITHUB_ACTIONS=true is required.');
  if (process.env.CI_RELEASE_FIXTURE_ENABLED !== 'true') throw new Error('CI_RELEASE_FIXTURE_ENABLED=true is required.');

  const environment = (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development').toLowerCase();
  if (environment === 'production') throw new Error('CI release fixture is forbidden in production.');

  const rawDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (!rawDatabaseUrl) throw new Error('DATABASE_URL is required.');
  const databaseUrl = new URL(rawDatabaseUrl);
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!loopbackHosts.has(databaseUrl.hostname.toLowerCase())) {
    throw new Error('CI release fixture requires a loopback database host.');
  }
  if (databaseUrl.pathname.replace(/^\//, '') !== 'salary_settlement') {
    throw new Error('CI release fixture requires the salary_settlement temporary database.');
  }

  const githubWorkspace = process.env.GITHUB_WORKSPACE?.trim();
  if (!githubWorkspace || !root.toLowerCase().startsWith(resolve(githubWorkspace).toLowerCase())) {
    throw new Error('CI release fixture must run inside GITHUB_WORKSPACE.');
  }
}

async function main(): Promise<void> {
  assertCiOnly();
  if (process.argv.includes('--validate-only')) {
    console.log('CI release fixture safeguards are valid; no database writes were performed.');
    return;
  }

  const superAdminRole = await prisma.role.findUnique({
    where: { code: 'super_admin' },
    include: { permissions: { include: { permission: true } } },
  });
  if (!superAdminRole || superAdminRole.status !== CommonStatus.active) {
    throw new Error('Active super_admin role is missing; run pnpm db:seed first.');
  }
  const assignedPermissions = new Set(superAdminRole.permissions.map((item) => item.permission.code));
  const missingPermissions = PERMISSIONS.filter((permission) => !assignedPermissions.has(permission));
  if (missingPermissions.length > 0) {
    throw new Error(`super_admin is missing ${missingPermissions.length} seeded permissions.`);
  }

  const admin = await prisma.adminUser.upsert({
    where: { username: adminUsername },
    update: {
      passwordHash: 'ci-fixture-login-disabled',
      displayName: 'CI Release Fixture Administrator',
      email: adminEmail,
      status: CommonStatus.active,
    },
    create: {
      username: adminUsername,
      passwordHash: 'ci-fixture-login-disabled',
      displayName: 'CI Release Fixture Administrator',
      email: adminEmail,
      status: CommonStatus.active,
    },
  });
  await prisma.adminUserRole.upsert({
    where: { adminUserId_roleId: { adminUserId: admin.id, roleId: superAdminRole.id } },
    update: {},
    create: { adminUserId: admin.id, roleId: superAdminRole.id },
  });

  const now = new Date();
  const fixtureMetadata = {
    source: fixtureSource,
    fixtureOnly: true,
    productionEvidence: false,
    warning: 'Synthetic CI-only record; not proof of a production backup or restore drill.',
  };
  await prisma.backupRecord.upsert({
    where: { backupKey },
    update: {
      status: BackupStatus.succeeded,
      backupType: BackupType.full,
      startedAt: now,
      completedAt: now,
      storageAlias: 'ci-fixture-ephemeral-storage',
      fileSizeBytes: 1n,
      checksumSha256: '0'.repeat(64),
      encrypted: true,
      encryptionAlias: 'ci-fixture-synthetic-marker',
      scopeSummary: { fixtureOnly: true, database: 'ephemeral-ci' },
      safeMetadata: fixtureMetadata,
      failureReason: null,
    },
    create: {
      backupKey,
      status: BackupStatus.succeeded,
      backupType: BackupType.full,
      startedAt: now,
      completedAt: now,
      storageAlias: 'ci-fixture-ephemeral-storage',
      fileSizeBytes: 1n,
      checksumSha256: '0'.repeat(64),
      encrypted: true,
      encryptionAlias: 'ci-fixture-synthetic-marker',
      scopeSummary: { fixtureOnly: true, database: 'ephemeral-ci' },
      safeMetadata: fixtureMetadata,
    },
  });
  await prisma.restoreDrillRecord.upsert({
    where: { drillKey },
    update: {
      status: RestoreDrillStatus.succeeded,
      environmentAlias: 'ci-fixture-ephemeral',
      backupKey,
      startedAt: now,
      completedAt: now,
      validationSummary: { fixtureOnly: true, gatePathExercised: true },
      safeMetadata: fixtureMetadata,
      failureReason: null,
    },
    create: {
      drillKey,
      status: RestoreDrillStatus.succeeded,
      environmentAlias: 'ci-fixture-ephemeral',
      backupKey,
      startedAt: now,
      completedAt: now,
      validationSummary: { fixtureOnly: true, gatePathExercised: true },
      safeMetadata: fixtureMetadata,
    },
  });

  await prisma.auditLog.upsert({
    where: { id: auditFixtureId },
    update: {
      actorUserId: admin.id,
      actorRole: 'release_preflight',
      action: 'ci_release_fixture',
      objectType: 'ci_release_fixture',
      objectId: fixtureVersion,
      afterData: { fixtureOnly: true, productionEvidence: false },
      changedFields: [],
      requestPayload: { source: fixtureSource, fixtureOnly: true, productionEvidence: false },
      result: 'success',
      ipAddress: '127.0.0.1',
      userAgent: 'github-actions-ci-release-fixture',
      createdAt: now,
    },
    create: {
      id: auditFixtureId,
      actorUserId: admin.id,
      actorRole: 'release_preflight',
      action: 'ci_release_fixture',
      objectType: 'ci_release_fixture',
      objectId: fixtureVersion,
      afterData: { fixtureOnly: true, productionEvidence: false },
      changedFields: [],
      requestPayload: { source: fixtureSource, fixtureOnly: true, productionEvidence: false },
      result: 'success',
      ipAddress: '127.0.0.1',
      userAgent: 'github-actions-ci-release-fixture',
      createdAt: now,
    },
  });

  const activeCriticalAlerts = await prisma.alert.count({
    where: { status: AlertStatus.active, severity: AlertSeverity.critical },
  });
  if (activeCriticalAlerts !== 0) throw new Error('CI fixture database contains active critical alerts.');

  const evidenceDir = resolve(root, 'tmp', 'release-evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const context = {
    schemaVersion: 1,
    type: 'ci-release-fixture-context',
    fixtureVersion,
    fixtureOnly: true,
    productionEvidence: false,
    generatedAt: now.toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    databaseHostClass: 'loopback',
    warning: 'This artifact proves only that code and the release-gate chain ran against synthetic CI fixtures. It is not evidence of a production backup, restore drill, or production readiness.',
  };
  writeFileSync(resolve(evidenceDir, 'ci-fixture-context.json'), `${JSON.stringify(context, null, 2)}\n`, 'utf8');
  writeFileSync(
    resolve(evidenceDir, 'CI-FIXTURE-NOTICE.md'),
    '# CI fixture evidence only\n\nThis run used synthetic records in an ephemeral GitHub Actions database. It proves only that the code and release-gate chain executed. It is not evidence of a production backup, restore drill, production database state, or production readiness.\n',
    'utf8',
  );

  console.log('CI-only release fixture prepared. Production evidence: false.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'CI release fixture failed.');
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
