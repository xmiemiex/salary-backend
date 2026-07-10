import { AlertSeverity, AlertStatus } from '@prisma/client';
import { AlertsService } from './alerts.service';
import { NotificationsService } from './notifications.service';

const actor = { userId: '11111111-1111-1111-1111-111111111111', roleCode: 'super_admin', permissions: ['alerts.manage'] };

describe('AlertsService', () => {
  it('deduplicates fingerprints, updates active alerts, resolves disappeared alerts, and notifies super admins once', async () => {
    const now = new Date('2026-07-08T00:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const prisma = prismaMock();
    const audit = auditMock();
    const health = {
      getSystemHealth: jest.fn().mockResolvedValue({
        checks: [
          { code: 'DATABASE_CONNECTED', status: 'critical', title: '数据库连接失败', message: 'Prisma 轻量查询失败。', safeDetails: { DATABASE_URL: 'hidden' } },
        ],
      }),
    };
    const notifications = { notifySuperAdmins: jest.fn().mockResolvedValue(1) };
    const service = new AlertsService(prisma as never, audit as never, health as never, notifications as never);

    const first = await service.scan(actor);
    expect(first.generated).toBe(1);
    expect(first.notificationsCreated).toBe(1);
    expect(prisma.alert.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        fingerprint: 'system-health:DATABASE_CONNECTED',
        severity: AlertSeverity.critical,
        status: AlertStatus.active,
      }),
    }));
    expect(JSON.stringify(prisma.alert.create.mock.calls)).not.toMatch(/DATABASE_URL|token|password|secret|leaseOwner/i);

    prisma.alert.findUnique.mockResolvedValueOnce({
      ...alertRecord,
      fingerprint: 'system-health:DATABASE_CONNECTED',
      status: AlertStatus.active,
      safeDetails: {},
    });
    const second = await service.scan(actor);
    expect(second.updated).toBe(1);
    expect(notifications.notifySuperAdmins).toHaveBeenCalledTimes(1);

    health.getSystemHealth.mockResolvedValueOnce({ checks: [] });
    prisma.alert.findMany.mockResolvedValueOnce([{ ...alertRecord, status: AlertStatus.active, fingerprint: 'system-health:DATABASE_CONNECTED' }]);
    const third = await service.scan(actor);
    expect(third.resolved).toBe(1);
    expect(prisma.alert.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: AlertStatus.resolved }),
    }));
    jest.useRealTimers();
  });

  it('reactivates a resolved alert using the same fingerprint and keeps firstSeenAt lifecycle', async () => {
    const prisma = prismaMock();
    const audit = auditMock();
    const notifications = { notifySuperAdmins: jest.fn().mockResolvedValue(1) };
    prisma.alert.findUnique.mockResolvedValueOnce({ ...alertRecord, status: AlertStatus.resolved, resolvedAt: new Date('2026-07-07T00:00:00.000Z') });
    const service = new AlertsService(
      prisma as never,
      audit as never,
      { getSystemHealth: jest.fn().mockResolvedValue({ checks: [{ code: 'AUDIT_LOG_READABLE', status: 'critical', title: '审计日志可读', message: '查询失败。' }] }) } as never,
      notifications as never,
    );

    const result = await service.scan(actor);
    expect(result.reactivated).toBe(1);
    expect(prisma.alert.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: AlertStatus.active, resolvedAt: null }),
    }));
    expect(notifications.notifySuperAdmins).toHaveBeenCalledTimes(1);
  });

  it('marks notifications read only for the current recipient', async () => {
    const prisma = notificationPrismaMock();
    const service = new NotificationsService(prisma as never, auditMock() as never);
    const result = await service.markRead('22222222-2222-2222-2222-222222222222', actor);
    expect(result.readAt).toBeInstanceOf(Date);
    expect(prisma.notification.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: '22222222-2222-2222-2222-222222222222', recipientId: actor.userId, readAt: null },
    }));
  });
});

const alertRecord = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  fingerprint: 'system-health:AUDIT_LOG_READABLE',
  severity: AlertSeverity.critical,
  status: AlertStatus.active,
  source: 'system_health',
  category: 'audit',
  title: '审计日志可读',
  safeMessage: '查询失败。',
  safeDetails: {},
  firstSeenAt: new Date('2026-07-07T00:00:00.000Z'),
  lastSeenAt: new Date('2026-07-07T00:00:00.000Z'),
  resolvedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  silencedUntil: null,
  createdAt: new Date('2026-07-07T00:00:00.000Z'),
  updatedAt: new Date('2026-07-07T00:00:00.000Z'),
};

function prismaMock() {
  const prisma: any = {
    $transaction: jest.fn(async (work: any) => work(prisma)),
    alert: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...alertRecord, ...data, id: alertRecord.id })),
      upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve({ ...alertRecord, ...create, id: alertRecord.id })),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...alertRecord, ...data })),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    syncTask: { findMany: jest.fn().mockResolvedValue([]) },
    affiliateAccount: { count: jest.fn().mockResolvedValue(0) },
    cardProviderCredential: { count: jest.fn().mockResolvedValue(2) },
  };
  return prisma;
}

function notificationPrismaMock() {
  return {
    notification: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({
        id: '22222222-2222-2222-2222-222222222222',
        recipientId: actor.userId,
        alertId: alertRecord.id,
        type: 'alert.generated',
        severity: AlertSeverity.critical,
        title: '告警',
        safeMessage: '摘要',
        safeDetails: {},
        readAt: null,
        createdAt: new Date('2026-07-08T00:00:00.000Z'),
      }),
    },
  };
}

function auditMock() {
  return {
    success: jest.fn().mockResolvedValue({}),
    failure: jest.fn().mockResolvedValue({}),
  };
}
