import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AlertSeverity, AlertStatus, AuditResult, BackupStatus, BackupType, CommonStatus, PrismaClient, RestoreDrillStatus } from '@prisma/client';
import { PERMISSIONS } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { AuthController } from '../auth/auth.controller';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService, hashSessionToken } from '../auth/auth.service';
import { ChangePasswordRateLimiterService } from '../auth/change-password-rate-limiter.service';
import { LoginRateLimiterService } from '../auth/login-rate-limiter.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { BackupHealthService } from '../backup-recovery/backup-health.service';
import { AppExceptionFilter } from '../common/app-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { SystemHealthService } from '../system-health/system-health.service';
import { ReleaseGateController } from './release-gate.controller';
import { ReleaseGateService } from './release-gate.service';

const databaseDescribe = process.env.TASK65_DATABASE_TESTS === '1' ? describe : describe.skip;
const request: any = require('supertest');

databaseDescribe('ReleaseGate PostgreSQL integration', () => {
  jest.setTimeout(180_000);

  const baseUrl = process.env.DATABASE_URL!;
  const schema = `rg65_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  const now = new Date('2026-07-09T08:00:00.000Z');

  let admin: PrismaClient;
  let db: PrismaClient;
  let app: INestApplication;
  let service: ReleaseGateService;
  let highToken: string;
  let readToken: string;
  let lowToken: string;
  let highUserId: string;
  let lowUserId: string;

  beforeAll(async () => {
    if (!baseUrl) throw new Error('DATABASE_URL is required when TASK65_DATABASE_TESTS=1.');
    admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'pnpm', process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm prisma migrate deploy'] : ['prisma', 'migrate', 'deploy'], { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' });
    db = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
    await seedReleaseActors();
    const audit = new AuditService(db as never);
    const backupHealth = new BackupHealthService(db as never);
    service = new ReleaseGateService(db as never, audit, new SystemHealthService(db as never, backupHealth), backupHealth);
    app = await createApiApp();
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.alert.deleteMany();
    await db.auditLog.deleteMany();
    await db.backupRecord.deleteMany();
    await db.restoreDrillRecord.deleteMany();
    await db.adminUser.deleteMany({ where: { username: { startsWith: 'e2e_', mode: 'insensitive' } } });
    await db.backupRecord.create({ data: backupCreateData('good') });
    await db.restoreDrillRecord.create({ data: drillCreateData('good', 'rg65-good') });
  });

  it('passes real super_admin and permission completeness checks', async () => {
    const result = await service.getReleaseGate();
    expect(result.checks.find((item) => item.code === 'ENABLED_SUPER_ADMIN_PRESENT')?.status).toBe('pass');
    expect(result.checks.find((item) => item.code === 'PERMISSIONS_TABLE_COMPLETE')?.status).toBe('pass');
  });

  it('fails on real active critical alert', async () => {
    await db.alert.create({ data: alertData('rg65-critical') });
    const result = await service.getReleaseGate();
    expect(result.checks.find((item) => item.code === 'ACTIVE_CRITICAL_ALERTS_ZERO')?.status).toBe('fail');
  });

  it('calculates real backup health fail and pass', async () => {
    let result = await service.getReleaseGate();
    expect(result.checks.find((item) => item.code === 'RECENT_FULL_BACKUP_WITHIN_72H')?.status).toBe('pass');
    await db.backupRecord.deleteMany();
    result = await service.getReleaseGate();
    expect(result.checks.find((item) => item.code === 'RECENT_FULL_BACKUP_WITHIN_72H')?.status).toBe('fail');
  });

  it('detects real test data residue', async () => {
    await db.adminUser.create({ data: { username: 'e2e_release_residue', displayName: 'Residue', passwordHash: 'test-only', status: CommonStatus.active } });
    const result = await service.getReleaseGate();
    expect(result.checks.find((item) => item.code === 'TEST_DATA_RESIDUE_ZERO')?.status).toBe('fail');
  });

  it('writes sanitized run audit', async () => {
    await request(app.getHttpServer()).post('/release-gate/run').set('Authorization', `Bearer ${highToken}`).expect(201);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'release_gate.run', result: AuditResult.success } });
    expect(audit.actorUserId).toBe(highUserId);
    expect(JSON.stringify(audit)).not.toMatch(/password|tokenHash|apiKey|secret|authorization|DATABASE_URL|credentialPayload|encryptedPayload|leaseOwner|providerResponse|rawResponse|requestHeaders|responseHeaders/i);
  });

  it('keeps low-permission API session alive after 403', async () => {
    await request(app.getHttpServer()).get('/release-gate').set('Authorization', `Bearer ${lowToken}`).expect(403);
    await request(app.getHttpServer()).post('/release-gate/run').set('Authorization', `Bearer ${readToken}`).expect(403);
    const me = await request(app.getHttpServer()).get('/me').set('Authorization', `Bearer ${lowToken}`).expect(200);
    expect(me.body.actor.userId).toBe(lowUserId);
  });

  it('returns API JSON without sensitive fields', async () => {
    const response = await request(app.getHttpServer()).get('/release-gate').set('Authorization', `Bearer ${highToken}`).expect(200);
    expect(JSON.stringify(response.body)).not.toMatch(/password|tokenHash|apiKey|secret|authorization|DATABASE_URL|credentialPayload|encryptedPayload|leaseOwner|providerResponse|rawResponse|requestHeaders|responseHeaders/i);
  });

  async function seedReleaseActors() {
    for (const code of PERMISSIONS) {
      await db.permission.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const superRole = await db.role.create({ data: { code: 'super_admin', name: 'Super Admin', status: CommonStatus.active } });
    const readRole = await db.role.create({ data: { code: 'rg65_read', name: 'Release Gate Read', status: CommonStatus.active } });
    const lowRole = await db.role.create({ data: { code: 'rg65_low', name: 'Release Gate Low', status: CommonStatus.active } });
    const permissions = await db.permission.findMany();
    await db.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: superRole.id, permissionId: permission.id })) });
    const readPermission = await db.permission.findUniqueOrThrow({ where: { code: 'release_gate.read' } });
    await db.rolePermission.create({ data: { roleId: readRole.id, permissionId: readPermission.id } });

    const high = await db.adminUser.create({ data: { username: 'rg65_high', displayName: 'RG65 High', passwordHash: 'test-only', status: CommonStatus.active } });
    const reader = await db.adminUser.create({ data: { username: 'rg65_reader', displayName: 'RG65 Reader', passwordHash: 'test-only', status: CommonStatus.active } });
    const low = await db.adminUser.create({ data: { username: 'rg65_low', displayName: 'RG65 Low', passwordHash: 'test-only', status: CommonStatus.active } });
    await db.adminUserRole.createMany({ data: [{ adminUserId: high.id, roleId: superRole.id }, { adminUserId: reader.id, roleId: readRole.id }, { adminUserId: low.id, roleId: lowRole.id }] });
    highUserId = high.id;
    lowUserId = low.id;
    highToken = `rg65_high_${randomUUID()}`;
    readToken = `rg65_read_${randomUUID()}`;
    lowToken = `rg65_low_${randomUUID()}`;
    await db.adminSession.createMany({ data: [
      { adminUserId: high.id, tokenHash: hashSessionToken(highToken), expiresAt: new Date(Date.now() + 60 * 60_000) },
      { adminUserId: reader.id, tokenHash: hashSessionToken(readToken), expiresAt: new Date(Date.now() + 60 * 60_000) },
      { adminUserId: low.id, tokenHash: hashSessionToken(lowToken), expiresAt: new Date(Date.now() + 60 * 60_000) },
    ] });
  }

  async function createApiApp() {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReleaseGateController, AuthController],
      providers: [
        ReleaseGateService,
        AuditService,
        BackupHealthService,
        SystemHealthService,
        AuthGuard,
        PermissionsGuard,
        { provide: PrismaService, useValue: db },
        { provide: AuthService, useValue: authServiceStub() },
        { provide: LoginRateLimiterService, useValue: { check: jest.fn() } },
        { provide: ChangePasswordRateLimiterService, useValue: { check: jest.fn(), reset: jest.fn(), recordFailure: jest.fn() } },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
      ],
    }).compile();
    const nestApp = moduleRef.createNestApplication();
    await nestApp.init();
    return nestApp;
  }
});

function backupCreateData(suffix: string) {
  return {
    backupKey: `rg65-${suffix}`,
    status: BackupStatus.succeeded,
    backupType: BackupType.full,
    startedAt: new Date('2026-07-09T07:00:00.000Z'),
    completedAt: new Date('2026-07-09T07:00:00.000Z'),
    storageAlias: 'primary-offsite',
    fileSizeBytes: 2048n,
    checksumSha256: 'a'.repeat(64),
    encrypted: true,
    encryptionAlias: 'kms-primary',
    scopeSummary: { tables: ['admin_users', 'audit_logs', 'sync_tasks'] },
    safeMetadata: { source: 'rg65-db-spec' },
  };
}

function drillCreateData(suffix: string, backupKey: string) {
  return {
    drillKey: `rg65-${suffix}`,
    status: RestoreDrillStatus.succeeded,
    environmentAlias: 'restore-ci',
    backupKey,
    startedAt: new Date('2026-07-09T07:00:00.000Z'),
    completedAt: new Date('2026-07-09T07:00:00.000Z'),
    validationSummary: { adminUsers: true, auditLogs: true, syncTasks: true },
    safeMetadata: { source: 'rg65-db-spec' },
  };
}

function alertData(fingerprint: string) {
  return {
    fingerprint,
    severity: AlertSeverity.critical,
    status: AlertStatus.active,
    source: 'release_gate_test',
    category: 'critical',
    title: 'Critical release blocker',
    safeMessage: 'Critical release blocker',
    safeDetails: { count: 1 },
    firstSeenAt: new Date('2026-07-09T07:00:00.000Z'),
    lastSeenAt: new Date('2026-07-09T07:00:00.000Z'),
  };
}

function authServiceStub() {
  return {
    login: jest.fn(),
    logout: jest.fn(),
    getSecurity: jest.fn(),
    changePassword: jest.fn(),
    isCurrentPasswordError: jest.fn().mockReturnValue(false),
    listSessions: jest.fn(),
    revokeSession: jest.fn(),
    logoutAll: jest.fn(),
  };
}

function withSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}
