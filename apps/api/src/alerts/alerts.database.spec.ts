import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AlertSeverity, AlertStatus, CommonStatus, Prisma, PrismaClient, Provider } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthController } from '../auth/auth.controller';
import { AuthGuard } from '../auth/auth.guard';
import { hashSessionToken, AuthService } from '../auth/auth.service';
import { Actor } from '../auth/auth.types';
import { ChangePasswordRateLimiterService } from '../auth/change-password-rate-limiter.service';
import { LoginRateLimiterService } from '../auth/login-rate-limiter.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { AppExceptionFilter } from '../common/app-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { SystemHealthService } from '../system-health/system-health.service';
import { AlertsService } from './alerts.service';
import { AlertsController } from './alerts.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

const databaseDescribe = process.env.TASK63_DATABASE_TESTS === '1' ? describe : describe.skip;
const request: any = require('supertest');

databaseDescribe('Alerts PostgreSQL integration', () => {
  jest.setTimeout(180_000);

  const baseUrl = process.env.DATABASE_URL!;
  const schema = `task63_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  const oldEnv = { ...process.env };
  const now = new Date('2026-07-08T08:00:00.000Z');

  let admin: PrismaClient;
  let db: PrismaClient;
  let highActor: Actor;
  let lowActor: Actor;
  let superAdminId: string;
  let highUserId: string;

  beforeAll(async () => {
    if (!baseUrl) throw new Error('DATABASE_URL is required when TASK63_DATABASE_TESTS=1.');
    Object.assign(process.env, {
      SYNC_AUTO_EXECUTION_ENABLED: 'false',
      SYNC_AUTO_EXECUTION_POLL_SECONDS: '60',
      SYNC_AUTO_EXECUTION_BATCH_SIZE: '2',
      SYNC_AUTO_EXECUTION_MAX_ATTEMPTS: '3',
      SYNC_AUTO_EXECUTION_LEASE_SECONDS: '900',
      SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS: '300',
    });

    admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const command = process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm prisma migrate deploy'] }
      : { file: 'pnpm', args: ['prisma', 'migrate', 'deploy'] };
    execFileSync(command.file, command.args, { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' });

    db = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
    await seedActors();
    await db.cardProviderCredential.createMany({
      data: [
        { provider: Provider.airwallex, encryptedPayload: 'must-not-leak-airwallex', status: CommonStatus.active },
        { provider: Provider.photonpay, encryptedPayload: 'must-not-leak-photonpay', status: CommonStatus.active },
      ],
    });
  });

  afterAll(async () => {
    Object.keys(process.env).forEach((key) => { if (!(key in oldEnv)) delete process.env[key]; });
    Object.assign(process.env, oldEnv);
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
  });

  it('enforces real fingerprint uniqueness at PostgreSQL level', async () => {
    await db.alert.create({ data: alertData('task63:fingerprint:unique') });
    await expect(db.alert.create({ data: alertData('task63:fingerprint:unique') })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('runs concurrent scans without duplicate alerts or duplicate unread notifications', async () => {
    const service = alertsService([{ code: 'TASK63_CONCURRENT', status: 'critical' }]);

    const results = await Promise.all([service.scan(highActor), service.scan(highActor)]);

    expect(results.reduce((sum, item) => sum + item.generated + item.updated + item.reactivated, 0)).toBeGreaterThanOrEqual(2);
    expect(await db.alert.count({ where: { fingerprint: 'system-health:TASK63_CONCURRENT' } })).toBe(1);
    const alert = await db.alert.findUniqueOrThrow({ where: { fingerprint: 'system-health:TASK63_CONCURRENT' } });
    expect(await db.notification.count({ where: { alertId: alert.id, recipientId: superAdminId, readAt: null } })).toBe(1);
    expect(await db.notification.count({ where: { alertId: alert.id, recipientId: highUserId, readAt: null } })).toBe(1);
    await expectNoSensitiveData();
  });

  it('updates repeated scans, auto resolves disappeared alerts, and reactivates resolved alerts with the same fingerprint', async () => {
    const activeService = alertsService([{ code: 'TASK63_LIFECYCLE', status: 'warning' }]);
    await activeService.scan(highActor);
    const first = await db.alert.findUniqueOrThrow({ where: { fingerprint: 'system-health:TASK63_LIFECYCLE' } });

    await activeService.scan(highActor);
    const repeated = await db.alert.findUniqueOrThrow({ where: { fingerprint: 'system-health:TASK63_LIFECYCLE' } });
    expect(repeated.id).toBe(first.id);
    expect(repeated.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());

    await alertsService([]).scan(highActor);
    const resolved = await db.alert.findUniqueOrThrow({ where: { fingerprint: 'system-health:TASK63_LIFECYCLE' } });
    expect(resolved.status).toBe(AlertStatus.resolved);
    expect(resolved.resolvedAt).toBeInstanceOf(Date);

    await activeService.scan(highActor);
    const reactivated = await db.alert.findUniqueOrThrow({ where: { fingerprint: 'system-health:TASK63_LIFECYCLE' } });
    expect(reactivated.id).toBe(first.id);
    expect(reactivated.status).toBe(AlertStatus.active);
    expect(reactivated.firstSeenAt.toISOString()).toBe(first.firstSeenAt.toISOString());
    expect(reactivated.resolvedAt).toBeNull();
  });

  it('reactivates expired silenced alerts but preserves future silence', async () => {
    await db.alert.create({
      data: {
        ...alertData('system-health:TASK63_SILENCE'),
        status: AlertStatus.silenced,
        silencedUntil: new Date(now.getTime() - 60_000),
      },
    });
    await alertsService([{ code: 'TASK63_SILENCE', status: 'warning' }]).scan(highActor);
    expect(await db.alert.findUnique({ where: { fingerprint: 'system-health:TASK63_SILENCE' } })).toMatchObject({
      status: AlertStatus.active,
      silencedUntil: null,
    });

    await db.alert.update({
      where: { fingerprint: 'system-health:TASK63_SILENCE' },
      data: { status: AlertStatus.silenced, silencedUntil: new Date(Date.now() + 60 * 60_000) },
    });
    await alertsService([{ code: 'TASK63_SILENCE', status: 'warning' }]).scan(highActor);
    expect(await db.alert.findUnique({ where: { fingerprint: 'system-health:TASK63_SILENCE' } })).toMatchObject({
      status: AlertStatus.silenced,
    });
  });

  it('keeps notification reads scoped to the current user and concurrency safe', async () => {
    const notifications = notificationService();
    const alert = await db.alert.create({ data: alertData('task63:notification:read') });
    await notifications.notifySuperAdmins(notificationInput(alert));
    const highNotification = await db.notification.findFirstOrThrow({ where: { recipientId: highUserId, alertId: alert.id, readAt: null } });

    await Promise.all([
      notifications.markRead(highNotification.id, highActor),
      notifications.markRead(highNotification.id, highActor),
      notifications.markAllRead(highActor),
    ]);

    expect(await db.notification.count({ where: { id: highNotification.id, recipientId: highUserId, readAt: { not: null } } })).toBe(1);
    expect((await notifications.list(lowActor)).total).toBe(0);
    expect((await notifications.list(highActor)).total).toBeGreaterThanOrEqual(1);
  });

  it('keeps a real low-permission session alive after restricted API 403 responses', async () => {
    const app = await createApiApp();
    const bearerToken = `task63_${randomUUID()}`;
    await db.adminSession.create({
      data: {
        adminUserId: lowActor.userId,
        tokenHash: hashSessionToken(bearerToken),
        expiresAt: new Date(Date.now() + 60 * 60_000),
        ipAddress: '127.0.0.1',
        userAgent: 'task63-database-spec',
      },
    });

    try {
      await request(app.getHttpServer()).get('/alerts').set('Authorization', `Bearer ${bearerToken}`).expect(403);
      await request(app.getHttpServer()).get('/notifications').set('Authorization', `Bearer ${bearerToken}`).expect(403);
      const me = await request(app.getHttpServer()).get('/me').set('Authorization', `Bearer ${bearerToken}`).expect(200);

      expect(me.body.actor).toMatchObject({ userId: lowActor.userId, roleCode: lowActor.roleCode, permissions: [] });
      expect(await db.adminSession.count({
        where: { adminUserId: lowActor.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      })).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  it('deduplicates alert notifications, writes sanitized audits, and returns filtered paginated alerts', async () => {
    const service = alertsService([
      {
        code: 'TASK63_FILTERED',
        status: 'critical',
        safeDetails: {
          DATABASE_URL: 'postgres://must-not-leak',
          requestHeaders: { authorization: 'Bearer must-not-leak' },
          safeCount: 1,
        },
      },
    ]);
    await service.scan(highActor);
    await service.scan(highActor);

    const alert = await db.alert.findUniqueOrThrow({ where: { fingerprint: 'system-health:TASK63_FILTERED' } });
    expect(await db.notification.count({ where: { alertId: alert.id, recipientId: superAdminId, readAt: null } })).toBe(1);
    expect(await service.list({ status: 'active', severity: 'critical', source: 'system_health', page: '1', pageSize: '1' })).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 1,
    });

    await service.acknowledge(alert.id, highActor);
    await service.silence(alert.id, { minutes: 30 }, highActor);
    const updated = await db.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(updated.acknowledgedBy).toBe(highActor.userId);
    expect(updated.status).toBe(AlertStatus.silenced);
    expect(await db.auditLog.count({ where: { action: { in: ['alert.generated', 'alert.scan_completed', 'alert.acknowledged', 'alert.silenced'] } } })).toBeGreaterThanOrEqual(4);
    await expectNoSensitiveData();
  });

  async function seedActors() {
    const codes = ['alerts.read', 'alerts.manage', 'notifications.read', 'notifications.manage'];
    for (const code of codes) {
      await db.permission.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const superRole = await db.role.create({ data: { code: 'super_admin', name: 'super_admin', status: CommonStatus.active } });
    const highRole = await db.role.create({ data: { code: 'task63_alert_reader', name: 'task63_alert_reader', status: CommonStatus.active } });
    const lowRole = await db.role.create({ data: { code: 'task63_low', name: 'task63_low', status: CommonStatus.active } });
    const permissions = await db.permission.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
    await db.rolePermission.createMany({
      data: [
        ...permissions.map((permission) => ({ roleId: superRole.id, permissionId: permission.id })),
        ...permissions.map((permission) => ({ roleId: highRole.id, permissionId: permission.id })),
      ],
    });
    const superAdmin = await db.adminUser.create({ data: { username: 'task63_super', displayName: 'Task63 Super', passwordHash: 'test-only', status: CommonStatus.active } });
    const high = await db.adminUser.create({ data: { username: 'task63_high', displayName: 'Task63 High', passwordHash: 'test-only', status: CommonStatus.active } });
    const low = await db.adminUser.create({ data: { username: 'task63_low', displayName: 'Task63 Low', passwordHash: 'test-only', status: CommonStatus.active } });
    await db.adminUserRole.createMany({ data: [
      { adminUserId: superAdmin.id, roleId: superRole.id },
      { adminUserId: high.id, roleId: highRole.id },
      { adminUserId: low.id, roleId: lowRole.id },
    ] });
    superAdminId = superAdmin.id;
    highUserId = high.id;
    highActor = { userId: high.id, roleCode: highRole.code, permissions: codes };
    lowActor = { userId: low.id, roleCode: lowRole.code, permissions: [] };
  }

  function alertsService(checks: Array<{ code: string; status: 'warning' | 'critical'; safeDetails?: Record<string, unknown> }>) {
    return new AlertsService(
      db as never,
      new AuditService(db as never),
      { getSystemHealth: jest.fn().mockResolvedValue({ checks: checks.map((item) => ({
        code: item.code,
        status: item.status,
        title: `Task63 ${item.code}`,
        message: `Task63 ${item.status} message`,
        safeDetails: item.safeDetails ?? { safeCount: 1 },
        remediation: '检查任务 63 数据库条件测试。',
      })) }) } as never,
      notificationService() as never,
    );
  }

  function notificationService() {
    return new NotificationsService(db as never, new AuditService(db as never));
  }

  async function createApiApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [AlertsController, NotificationsController, AuthController],
      providers: [
        AlertsService,
        NotificationsService,
        AuditService,
        AuthGuard,
        PermissionsGuard,
        { provide: PrismaService, useValue: db },
        { provide: SystemHealthService, useValue: { getSystemHealth: jest.fn().mockResolvedValue({ checks: [] }) } },
        { provide: AuthService, useValue: authServiceStub() },
        { provide: LoginRateLimiterService, useValue: { check: jest.fn() } },
        { provide: ChangePasswordRateLimiterService, useValue: { check: jest.fn(), reset: jest.fn(), recordFailure: jest.fn() } },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return app;
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

  function alertData(fingerprint: string) {
    return {
      fingerprint,
      severity: AlertSeverity.warning,
      status: AlertStatus.active,
      source: 'task63',
      category: 'database',
      title: 'Task63 database alert',
      safeMessage: 'Task63 database alert message',
      safeDetails: { safe: true },
      firstSeenAt: now,
      lastSeenAt: now,
    };
  }

  function notificationInput(alert: { id: string; severity: AlertSeverity; title: string; safeMessage: string; fingerprint: string; source: string; category: string }) {
    return {
      alertId: alert.id,
      type: 'alert.generated',
      severity: alert.severity,
      title: alert.title,
      safeMessage: alert.safeMessage,
      safeDetails: { alertId: alert.id, fingerprint: alert.fingerprint, source: alert.source, category: alert.category },
    };
  }

  async function expectNoSensitiveData() {
    const [alerts, notifications, audits] = await Promise.all([
      db.alert.findMany(),
      db.notification.findMany(),
      db.auditLog.findMany(),
    ]);
    expect(JSON.stringify({ alerts, notifications, audits })).not.toMatch(/postgres:\/\/must-not-leak|Bearer must-not-leak|DATABASE_URL|requestHeaders|authorization|token|password|secret|encryptedPayload|leaseOwner|providerResponse|rawResponse/i);
  }
});

function withSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}
