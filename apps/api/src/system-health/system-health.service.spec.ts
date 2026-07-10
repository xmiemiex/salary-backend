import { AuditResult, CommonStatus, Provider, SettlementStatus, SyncExecutionErrorCategory, SyncPlanningRunStatus, SyncTaskStatus, SyncTaskTriggerType } from '@prisma/client';
import { SystemHealthService } from './system-health.service';

const TEST_NOW = new Date('2026-07-08T04:00:00.000Z');

describe('SystemHealthService', () => {
  const oldEnv = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, {
      SYNC_PLANNER_ENABLED: 'true',
      SYNC_PLANNER_DAY: '1',
      SYNC_PLANNER_HOUR: '0',
      SYNC_PLANNER_TIMEZONE: 'Asia/Shanghai',
      SYNC_AUTO_EXECUTION_ENABLED: 'true',
      SYNC_AUTO_EXECUTION_POLL_SECONDS: '60',
      SYNC_AUTO_EXECUTION_BATCH_SIZE: '2',
      SYNC_AUTO_EXECUTION_MAX_ATTEMPTS: '3',
      SYNC_AUTO_EXECUTION_LEASE_SECONDS: '900',
      SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS: '300',
    });
  });

  afterEach(() => {
    Object.keys(process.env).forEach((key) => { if (!(key in oldEnv)) delete process.env[key]; });
    Object.assign(process.env, oldEnv);
  });

  it('aggregates warning and critical status, counts runtime state, and never returns sensitive fields', async () => {
    const prisma = prismaMock();
    const result = await new SystemHealthService(prisma as never).getSystemHealth(TEST_NOW);

    expect(result.status).toBe('critical');
    expect(result.database.connected).toBe(true);
    expect(result.autoExecution).toMatchObject({
      pendingEligibleCount: 2,
      runningCount: 1,
      retryWaitingCount: 1,
      failedCount: 1,
      expiredRunningLeaseCount: 1,
      manualTaskProtection: { protectedEligibleCount: 3, autoClaimsManualTasks: false },
    });
    expect(result.credentials).toMatchObject({
      disabledCredentialCount: 1,
      missingCredentialBlockerCount: 3,
    });
    expect(result.settlements).toMatchObject({
      currentMonthLocked: false,
      previousMonthLocked: true,
      lockedMonthBlockedSyncTaskCount: 1,
    });
    expect(result.audit).toMatchObject({ superAdminCount: 2, enabledSuperAdminCount: 1, enabledSuperAdminSafe: true });
    expect(result.e2e.permissionsE2eCommandExists).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/DATABASE_URL|leaseOwner|encryptedPayload|credentialPayload|token|passwordHash|providerResponse|rawResponse/i);
    expect(result.recentIncidents.length).toBeGreaterThan(0);
  });

  it('degrades database query failure into a safe critical summary', async () => {
    const prisma = prismaMock();
    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      if (Array.from(strings).join(' ').includes('SELECT now')) throw new Error('DATABASE_URL=postgres://secret');
      return Promise.resolve([]);
    });
    const result = await new SystemHealthService(prisma as never).getSystemHealth(TEST_NOW);
    expect(result.database.connected).toBe(false);
    expect(result.checks.some((item) => item.code === 'DATABASE_CONNECTED' && item.status === 'critical')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/postgres:\/\/secret|DATABASE_URL/i);
  });

  it('is read-only for planning, auto execution, and credentials', async () => {
    const prisma = prismaMock();
    await new SystemHealthService(prisma as never).getSystemHealth(TEST_NOW);
    expect((prisma.syncTask as any).update).toBeUndefined();
    expect((prisma.syncTask as any).updateMany).toBeUndefined();
    expect((prisma.syncTask as any).create).toBeUndefined();
    expect((prisma as any).affiliateAccountCredential?.findFirst).toBeUndefined();
    expect((prisma.cardProviderCredential as any).update).toBeUndefined();
  });

  it('aggregates ok, warning, and critical overall statuses', async () => {
    const prisma = prismaMock();
    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join(' ');
      if (sql.includes('SELECT now')) return Promise.resolve([{ now: TEST_NOW }]);
      if (sql.includes('_prisma_migrations')) return Promise.resolve([{ migration_name: 'baseline', finished_at: TEST_NOW, rolled_back_at: null }]);
      if (sql.includes('FROM sync_tasks t')) return Promise.resolve([{ pending: 0n, running: 0n, retry_wait: 0n, failed: 0n, expired: 0n, manual_protected: 0n }]);
      return Promise.resolve([]);
    });
    prisma.syncPlanningRun.findFirst.mockResolvedValue(null);
    prisma.syncPlanningRun.findUnique.mockResolvedValue({ settlementMonth: new Date('2026-06-01T00:00:00.000Z') });
    prisma.syncPlanningRun.count.mockResolvedValue(0);
    prisma.syncPlanningRun.findMany.mockResolvedValue([]);
    prisma.syncTask.findFirst.mockResolvedValue(null);
    prisma.syncTask.findMany.mockResolvedValue([]);
    prisma.syncTask.groupBy.mockResolvedValue([]);
    prisma.syncTask.count.mockResolvedValue(0);
    prisma.affiliateAccount.findMany.mockResolvedValue([{ platform: 'everflow', status: CommonStatus.active, credential: { status: CommonStatus.active, updatedAt: TEST_NOW } }]);
    prisma.cardProviderCredential.findMany.mockResolvedValue([
      { provider: Provider.airwallex, status: CommonStatus.active, updatedAt: TEST_NOW },
      { provider: Provider.photonpay, status: CommonStatus.active, updatedAt: TEST_NOW },
    ]);
    prisma.monthlySettlement.findUnique.mockReset().mockResolvedValue({ status: SettlementStatus.locked, lockedAt: TEST_NOW });
    prisma.monthlySettlement.findFirst.mockReset().mockResolvedValue({ settlementMonth: new Date('2026-06-01T00:00:00.000Z'), lockedAt: TEST_NOW });
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);
    prisma.adminUser.count.mockResolvedValue(1);

    process.env.SYNC_PLANNER_ENABLED = 'true';
    process.env.SYNC_AUTO_EXECUTION_ENABLED = 'true';
    const okResult = await new SystemHealthService(prisma as never).getSystemHealth(TEST_NOW);
    expect(okResult.status).toBe('ok');

    prisma.cardProviderCredential.findMany.mockResolvedValue([{ provider: Provider.airwallex, status: CommonStatus.active, updatedAt: TEST_NOW }]);
    expect((await new SystemHealthService(prisma as never).getSystemHealth(TEST_NOW)).status).toBe('warning');

    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      if (Array.from(strings).join(' ').includes('SELECT now')) throw new Error('down');
      return Promise.resolve([]);
    });
    expect((await new SystemHealthService(prisma as never).getSystemHealth(TEST_NOW)).status).toBe('critical');
  });
});

function prismaMock() {
  const latestPlanning = {
    status: SyncPlanningRunStatus.failed,
    settlementMonth: new Date('2026-06-01T00:00:00.000Z'),
    lastAttemptAt: new Date('2026-07-08T03:00:00.000Z'),
    lastSuccessAt: null,
    createdCount: 0,
    existingCount: 1,
    blockedCount: 2,
    blockerCodes: ['MONTH_LOCKED'],
    failureCode: 'SAFE_FAILURE',
  };
  return {
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join(' ');
      if (sql.includes('SELECT now')) return Promise.resolve([{ now: new Date('2026-07-08T04:00:00.500Z') }]);
      if (sql.includes('_prisma_migrations')) return Promise.resolve([{ migration_name: '20260708010000_add_system_health_read_permission', finished_at: new Date('2026-07-08T03:00:00.000Z'), rolled_back_at: null }]);
      if (sql.includes('FROM sync_tasks t')) return Promise.resolve([{ pending: 2n, running: 1n, retry_wait: 1n, failed: 1n, expired: 1n, manual_protected: 3n }]);
      return Promise.resolve([]);
    }),
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    syncPlanningRun: {
      findFirst: jest.fn().mockResolvedValue(latestPlanning),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([latestPlanning]),
    },
    syncTask: {
      findFirst: jest.fn()
        .mockResolvedValueOnce({ finishedAt: new Date('2026-07-08T02:00:00.000Z'), updatedAt: new Date('2026-07-08T02:00:00.000Z'), platform: 'everflow', provider: null })
        .mockResolvedValueOnce({ finishedAt: new Date('2026-07-08T02:30:00.000Z'), updatedAt: new Date('2026-07-08T02:30:00.000Z'), lastErrorCategory: SyncExecutionErrorCategory.NETWORK_ERROR, platform: 'airwallex', provider: Provider.airwallex }),
      groupBy: jest.fn().mockResolvedValue([{ lastErrorCategory: SyncExecutionErrorCategory.NETWORK_ERROR, _count: 2 }]),
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([
        { status: SyncTaskStatus.failed, sourceType: 'card_spend', platform: 'airwallex', provider: Provider.airwallex, settlementMonth: new Date('2026-06-01T00:00:00.000Z'), lastErrorCategory: SyncExecutionErrorCategory.CREDENTIAL_MISSING, errorMessage: 'authorization=[REDACTED]', updatedAt: new Date('2026-07-08T02:00:00.000Z'), leaseExpiresAt: null },
      ]),
    },
    affiliateAccount: {
      findMany: jest.fn().mockResolvedValue([
        { platform: 'everflow', status: CommonStatus.active, credential: { status: CommonStatus.active, updatedAt: TEST_NOW } },
        { platform: 'cake', status: CommonStatus.active, credential: null },
      ]),
    },
    cardProviderCredential: {
      findMany: jest.fn().mockResolvedValue([{ provider: Provider.airwallex, status: CommonStatus.disabled, updatedAt: TEST_NOW }]),
    },
    monthlySettlement: {
      findUnique: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ status: SettlementStatus.locked, lockedAt: TEST_NOW }),
      findFirst: jest.fn().mockResolvedValue({ settlementMonth: new Date('2026-06-01T00:00:00.000Z'), lockedAt: TEST_NOW }),
    },
    auditLog: {
      findMany: jest.fn((args: any) => {
        const text = JSON.stringify(args);
        if (text.includes('credential')) return Promise.resolve([{ action: 'api_credential.card_provider.disable', objectType: 'card_provider_credentials', result: AuditResult.success, createdAt: TEST_NOW, failureReason: null }]);
        if (text.includes('settlement.lock')) return Promise.resolve([{ action: 'settlement.lock', result: AuditResult.success, settlementMonth: new Date('2026-06-01T00:00:00.000Z'), createdAt: TEST_NOW }]);
        if (text.includes('role.')) return Promise.resolve([{ action: 'role.update', result: AuditResult.success, createdAt: TEST_NOW, failureReason: null }]);
        if (text.includes('admin_user.')) return Promise.resolve([{ action: 'admin_user.disable', result: AuditResult.success, createdAt: TEST_NOW, failureReason: null }]);
        return Promise.resolve([{ action: 'sync_task.auto.failed', objectType: 'sync_tasks', failureReason: 'NETWORK_ERROR', errorMessage: 'safe', createdAt: TEST_NOW }]);
      }),
      findFirst: jest.fn().mockResolvedValue({ action: 'audit_log.export', result: AuditResult.success, createdAt: TEST_NOW }),
      count: jest.fn().mockResolvedValue(0),
    },
    adminUser: {
      count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1),
    },
    alert: {
      count: jest.fn().mockResolvedValue(0),
    },
  };
}
