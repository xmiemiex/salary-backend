import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AlertStatus, AuditResult, BackupStatus, BackupType, CommonStatus, PrismaClient, RestoreDrillStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthController } from '../auth/auth.controller';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService, hashSessionToken } from '../auth/auth.service';
import { Actor } from '../auth/auth.types';
import { ChangePasswordRateLimiterService } from '../auth/change-password-rate-limiter.service';
import { LoginRateLimiterService } from '../auth/login-rate-limiter.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { AppExceptionFilter } from '../common/app-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { SystemHealthService } from '../system-health/system-health.service';
import { AlertsController } from '../alerts/alerts.controller';
import { AlertsService } from '../alerts/alerts.service';
import { NotificationsService } from '../alerts/notifications.service';
import { BackupHealthService } from './backup-health.service';
import { BackupRecoveryController } from './backup-recovery.controller';
import { BackupRecoveryService } from './backup-recovery.service';

const databaseDescribe = process.env.TASK64_DATABASE_TESTS === '1' ? describe : describe.skip;
const request: any = require('supertest');

databaseDescribe('BackupRecovery PostgreSQL integration', () => {
  jest.setTimeout(180_000);

  const baseUrl = process.env.DATABASE_URL!;
  const schema = `task64_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  const now = new Date('2026-07-09T08:00:00.000Z');

  let admin: PrismaClient;
  let db: PrismaClient;
  let app: INestApplication;
  let recovery: BackupRecoveryService;
  let health: BackupHealthService;
  let alerts: AlertsService;
  let highActor: Actor;
  let lowActor: Actor;
  let highToken: string;
  let lowToken: string;

  beforeAll(async () => {
    if (!baseUrl) throw new Error('DATABASE_URL is required when TASK64_DATABASE_TESTS=1.');
    admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const command = process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm prisma migrate deploy'] }
      : { file: 'pnpm', args: ['prisma', 'migrate', 'deploy'] };
    execFileSync(command.file, command.args, { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' });
    db = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
    await seedActors();

    const audit = new AuditService(db as never);
    health = new BackupHealthService(db as never);
    recovery = new BackupRecoveryService(db as never, audit);
    alerts = new AlertsService(
      db as never,
      audit,
      { getSystemHealth: jest.fn().mockResolvedValue({ checks: [] }) } as never,
      health,
      new NotificationsService(db as never, audit),
    );
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
    await db.notification.deleteMany();
    await db.alert.deleteMany();
    await db.auditLog.deleteMany();
    await db.restoreDrillRecord.deleteMany();
    await db.backupRecord.deleteMany();
  });

  it('enforces backupKey unique at the real PostgreSQL level', async () => {
    await db.backupRecord.create({ data: backupCreateData('unique-backup') });
    await expect(db.backupRecord.create({ data: backupCreateData('unique-backup') })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('enforces drillKey unique at the real PostgreSQL level', async () => {
    await db.restoreDrillRecord.create({ data: drillCreateData('unique-drill', null) });
    await expect(db.restoreDrillRecord.create({ data: drillCreateData('unique-drill', null) })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('creates and updates backup records through the service against PostgreSQL', async () => {
    const created = await recovery.createBackup(backupPayload('service-backup', BackupStatus.running), highActor);
    expect(created).toMatchObject({ backupKey: 'task64-service-backup', status: BackupStatus.running, storageAlias: 'primary-offsite' });

    const updated = await recovery.updateBackup(created.id, {
      status: BackupStatus.succeeded,
      completedAt: now.toISOString(),
      checksumSha256: 'b'.repeat(64),
      safeMetadata: { verification: 'passed' },
    }, highActor);
    expect(updated).toMatchObject({ id: created.id, status: BackupStatus.succeeded, checksumSha256: 'b'.repeat(64) });
    expect(await db.backupRecord.count({ where: { backupKey: 'task64-service-backup', status: BackupStatus.succeeded } })).toBe(1);
  });

  it('creates and updates restore drill records through the service against PostgreSQL', async () => {
    const backup = await db.backupRecord.create({ data: backupCreateData('drill-backup') });
    const created = await recovery.createDrill(drillPayload('service-drill', backup.backupKey, RestoreDrillStatus.running), highActor);
    expect(created).toMatchObject({ drillKey: 'task64-service-drill', status: RestoreDrillStatus.running, backupKey: backup.backupKey });

    const updated = await recovery.updateDrill(created.id, {
      status: RestoreDrillStatus.succeeded,
      completedAt: now.toISOString(),
      validationSummary: { adminUsers: true, auditLogs: true, syncTasks: true },
    }, highActor);
    expect(updated.status).toBe(RestoreDrillStatus.succeeded);
    expect(await db.restoreDrillRecord.count({ where: { drillKey: 'task64-service-drill', status: RestoreDrillStatus.succeeded } })).toBe(1);
  });

  it('calculates backup health from real records for ok, warning, and critical states', async () => {
    await db.backupRecord.create({ data: backupCreateData('ok-backup') });
    await db.restoreDrillRecord.create({ data: drillCreateData('ok-drill', 'task64-ok-backup') });
    expect((await health.getHealth(now)).status).toBe('ok');

    await db.backupRecord.update({ where: { backupKey: 'task64-ok-backup' }, data: { checksumSha256: null } });
    const warning = await health.getHealth(now);
    expect(warning.status).toBe('warning');
    expect(warning.checks.map((item) => item.code)).toContain('backup.checksum_missing');

    await db.backupRecord.create({ data: { ...backupCreateData('critical-backup'), status: BackupStatus.failed, startedAt: new Date(now.getTime() + 60_000), completedAt: new Date(now.getTime() + 60_000) } });
    const critical = await health.getHealth(now);
    expect(critical.status).toBe('critical');
    expect(critical.checks.map((item) => item.code)).toContain('backup.latest_failed');
  });

  it('generates backup alerts from real records and deduplicates stable fingerprints', async () => {
    await db.backupRecord.create({ data: { ...backupCreateData('alert-success'), status: BackupStatus.succeeded } });
    await db.restoreDrillRecord.create({ data: drillCreateData('alert-drill', 'task64-alert-success') });
    await db.backupRecord.create({ data: { ...backupCreateData('alert-failed'), status: BackupStatus.failed, startedAt: new Date(now.getTime() + 60_000), completedAt: new Date(now.getTime() + 60_000) } });

    await alerts.scan(highActor);
    await alerts.scan(highActor);

    expect(await db.alert.count({ where: { fingerprint: 'backup-recovery:backup.latest_failed' } })).toBe(1);
    const alert = await db.alert.findUniqueOrThrow({ where: { fingerprint: 'backup-recovery:backup.latest_failed' } });
    expect(alert.status).toBe(AlertStatus.active);
    expect(alert.source).toBe('backup');
  });

  it('resolves backup alerts after the underlying issue disappears', async () => {
    await db.backupRecord.create({ data: backupCreateData('resolve-success') });
    await db.restoreDrillRecord.create({ data: drillCreateData('resolve-drill', 'task64-resolve-success') });
    const failed = await db.backupRecord.create({ data: { ...backupCreateData('resolve-failed'), status: BackupStatus.failed, startedAt: new Date(now.getTime() + 60_000), completedAt: new Date(now.getTime() + 60_000) } });
    await alerts.scan(highActor);

    await db.backupRecord.update({
      where: { id: failed.id },
      data: { status: BackupStatus.succeeded, encrypted: true, checksumSha256: 'c'.repeat(64) },
    });
    await alerts.scan(highActor);

    const resolved = await db.alert.findUniqueOrThrow({ where: { fingerprint: 'backup-recovery:backup.latest_failed' } });
    expect(resolved.status).toBe(AlertStatus.resolved);
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
  });

  it('keeps a low-permission API session alive after backup API 403 responses', async () => {
    await request(app.getHttpServer()).get('/backup-records').set('Authorization', `Bearer ${lowToken}`).expect(403);
    await request(app.getHttpServer()).post('/backup-records').set('Authorization', `Bearer ${lowToken}`).send(backupPayload('denied', BackupStatus.running)).expect(403);
    const me = await request(app.getHttpServer()).get('/me').set('Authorization', `Bearer ${lowToken}`).expect(200);

    expect(me.body.actor).toMatchObject({ userId: lowActor.userId, roleCode: lowActor.roleCode, permissions: [] });
    expect(await db.adminSession.count({ where: { adminUserId: lowActor.userId, revokedAt: null, expiresAt: { gt: new Date() } } })).toBe(1);
  });

  it('writes sanitized audits for backup and restore changes', async () => {
    const backup = await recovery.createBackup(backupPayload('audit-backup', BackupStatus.running), highActor);
    await recovery.updateBackup(backup.id, { status: BackupStatus.succeeded, safeMetadata: { safe: 'summary' } }, highActor);
    const drill = await recovery.createDrill(drillPayload('audit-drill', backup.backupKey, RestoreDrillStatus.running), highActor);
    await recovery.updateDrill(drill.id, { status: RestoreDrillStatus.succeeded, safeMetadata: { safe: 'summary' } }, highActor);

    const audits = await db.auditLog.findMany({ where: { action: { in: ['backup_record.created', 'backup_record.updated', 'restore_drill.created', 'restore_drill.updated'] } } });
    expect(audits).toHaveLength(4);
    expect(JSON.stringify(audits)).not.toMatch(/password|token|apiKey|secret|authorization|DATABASE_URL|credentialPayload|encryptedPayload|https?:\/\/|s3:\/\//i);
  });

  it('returns API JSON without sensitive fields or values', async () => {
    const backup = await recovery.createBackup(backupPayload('api-json', BackupStatus.succeeded), highActor);
    await recovery.createDrill(drillPayload('api-json', backup.backupKey, RestoreDrillStatus.succeeded), highActor);

    const responses = [
      await request(app.getHttpServer()).get('/backup-records').set('Authorization', `Bearer ${highToken}`).expect(200),
      await request(app.getHttpServer()).get(`/backup-records/${backup.id}`).set('Authorization', `Bearer ${highToken}`).expect(200),
      await request(app.getHttpServer()).get('/restore-drills').set('Authorization', `Bearer ${highToken}`).expect(200),
      await request(app.getHttpServer()).get('/backup-health').set('Authorization', `Bearer ${highToken}`).expect(200),
      await request(app.getHttpServer()).post('/backup-records').set('Authorization', `Bearer ${highToken}`).send({ ...backupPayload('unsafe-api', BackupStatus.running), storageAlias: 's3://bucket/file.dump' }).expect(400),
      await request(app.getHttpServer()).post('/restore-drills').set('Authorization', `Bearer ${highToken}`).send({ ...drillPayload('unsafe-api', backup.backupKey, RestoreDrillStatus.running), safeMetadata: { token: 'must-not-echo' } }).expect(400),
    ];

    for (const response of responses) {
      expect(JSON.stringify(response.body)).not.toMatch(/must-not-echo|password|token|apiKey|secret|authorization|DATABASE_URL|credentialPayload|encryptedPayload|https?:\/\/|s3:\/\//i);
    }
  });

  async function seedActors() {
    const permissionCodes = ['backup_status.read', 'backup_status.manage', 'restore_drill.read', 'restore_drill.manage', 'alerts.read', 'alerts.manage'];
    for (const code of permissionCodes) {
      await db.permission.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const highRole = await db.role.create({ data: { code: 'task64_manager', name: 'Task64 Manager', status: CommonStatus.active } });
    const lowRole = await db.role.create({ data: { code: 'task64_low', name: 'Task64 Low', status: CommonStatus.active } });
    const permissions = await db.permission.findMany({ where: { code: { in: permissionCodes } }, select: { id: true } });
    await db.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: highRole.id, permissionId: permission.id })) });

    const high = await db.adminUser.create({ data: { username: 'task64_high', displayName: 'Task64 High', passwordHash: 'test-only', status: CommonStatus.active } });
    const low = await db.adminUser.create({ data: { username: 'task64_low', displayName: 'Task64 Low', passwordHash: 'test-only', status: CommonStatus.active } });
    await db.adminUserRole.createMany({ data: [{ adminUserId: high.id, roleId: highRole.id }, { adminUserId: low.id, roleId: lowRole.id }] });

    highActor = { userId: high.id, roleCode: highRole.code, permissions: permissionCodes, ipAddress: '127.0.0.1', userAgent: 'task64-db-spec' };
    lowActor = { userId: low.id, roleCode: lowRole.code, permissions: [], ipAddress: '127.0.0.1', userAgent: 'task64-db-spec' };
    highToken = `task64_high_${randomUUID()}`;
    lowToken = `task64_low_${randomUUID()}`;
    await db.adminSession.createMany({ data: [
      { adminUserId: high.id, tokenHash: hashSessionToken(highToken), expiresAt: new Date(Date.now() + 60 * 60_000), ipAddress: '127.0.0.1', userAgent: 'task64-db-spec' },
      { adminUserId: low.id, tokenHash: hashSessionToken(lowToken), expiresAt: new Date(Date.now() + 60 * 60_000), ipAddress: '127.0.0.1', userAgent: 'task64-db-spec' },
    ] });
  }

  async function createApiApp() {
    const audit = new AuditService(db as never);
    const moduleRef = await Test.createTestingModule({
      controllers: [BackupRecoveryController, AlertsController, AuthController],
      providers: [
        BackupRecoveryService,
        BackupHealthService,
        AlertsService,
        NotificationsService,
        AuditService,
        AuthGuard,
        PermissionsGuard,
        { provide: PrismaService, useValue: db },
        { provide: AuthService, useValue: authServiceStub() },
        { provide: SystemHealthService, useValue: { getSystemHealth: jest.fn().mockResolvedValue({ checks: [] }) } },
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

  function backupPayload(suffix: string, status: BackupStatus) {
    return {
      backupKey: `task64-${suffix}`,
      status,
      backupType: BackupType.full,
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      storageAlias: 'primary-offsite',
      fileSizeBytes: '2048',
      checksumSha256: 'a'.repeat(64),
      encrypted: true,
      encryptionAlias: 'kms-primary',
      scopeSummary: { tables: ['admin_users', 'audit_logs', 'sync_tasks'] },
      safeMetadata: { source: 'task64-db-spec' },
      failureReason: status === BackupStatus.failed ? 'safe failure summary' : null,
    };
  }

  function drillPayload(suffix: string, backupKey: string | null, status: RestoreDrillStatus) {
    return {
      drillKey: `task64-${suffix}`,
      status,
      environmentAlias: 'restore-ci',
      backupKey,
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      validationSummary: { adminUsers: true, auditLogs: true, syncTasks: true },
      safeMetadata: { source: 'task64-db-spec' },
      failureReason: status === RestoreDrillStatus.failed ? 'safe drill failure' : null,
    };
  }

  function backupCreateData(suffix: string) {
    return {
      backupKey: `task64-${suffix}`,
      status: BackupStatus.succeeded,
      backupType: BackupType.full,
      startedAt: now,
      completedAt: now,
      storageAlias: 'primary-offsite',
      fileSizeBytes: 2048n,
      checksumSha256: 'a'.repeat(64),
      encrypted: true,
      encryptionAlias: 'kms-primary',
      scopeSummary: { tables: ['admin_users', 'audit_logs', 'sync_tasks'] },
      safeMetadata: { source: 'task64-db-spec' },
    };
  }

  function drillCreateData(suffix: string, backupKey: string | null) {
    return {
      drillKey: `task64-${suffix}`,
      status: RestoreDrillStatus.succeeded,
      environmentAlias: 'restore-ci',
      backupKey,
      startedAt: now,
      completedAt: now,
      validationSummary: { adminUsers: true, auditLogs: true, syncTasks: true },
      safeMetadata: { source: 'task64-db-spec' },
    };
  }
});

function withSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}
