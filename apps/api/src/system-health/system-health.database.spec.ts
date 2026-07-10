import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  AuditResult,
  CommonStatus,
  PrismaClient,
  Provider,
  SettlementStatus,
  SyncExecutionErrorCategory,
  SyncPlanningRunStatus,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskStatus,
  SyncTaskTriggerType,
  SyncTaskType,
} from '@prisma/client';
import { SystemHealthService } from './system-health.service';

const databaseDescribe = process.env.TASK62_DATABASE_TESTS === '1' ? describe : describe.skip;

databaseDescribe('SystemHealthService PostgreSQL integration', () => {
  jest.setTimeout(180_000);
  const baseUrl = process.env.DATABASE_URL!;
  const schema = `task62_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  const month = new Date('2043-01-01T00:00:00.000Z');
  const lockedMonth = new Date('2043-02-01T00:00:00.000Z');
  let admin: PrismaClient;
  let client: PrismaClient;
  let accountId: string;

  beforeAll(async () => {
    if (!baseUrl) throw new Error('DATABASE_URL is required when TASK62_DATABASE_TESTS=1.');
    admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const command = process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm prisma migrate deploy'] }
      : { file: 'pnpm', args: ['prisma', 'migrate', 'deploy'] };
    execFileSync(command.file, command.args, { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' });
    client = new PrismaClient({ datasources: { db: { url: schemaUrl } } });

    const adminUser = await client.adminUser.create({ data: { username: 'task62_super', displayName: 'Task62 Super', passwordHash: 'test-only' } });
    const permission = await client.permission.upsert({ where: { code: 'system_health.read' }, update: {}, create: { code: 'system_health.read', name: 'system_health.read' } });
    const role = await client.role.create({ data: { code: 'super_admin', name: 'super_admin', status: CommonStatus.active } });
    await client.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await client.adminUserRole.create({ data: { adminUserId: adminUser.id, roleId: role.id } });

    const account = await client.affiliateAccount.create({ data: { platform: 'everflow', accountCode: 'task62', accountName: 'task62', status: CommonStatus.active } });
    accountId = account.id;
    await client.affiliateAccountCredential.create({ data: { affiliateAccountId: account.id, encryptedPayload: 'must-not-read', maskedPayload: { configured: true }, status: CommonStatus.active } });
    await client.cardProviderCredential.create({ data: { provider: Provider.airwallex, encryptedPayload: 'must-not-read', maskedPayload: { configured: true }, status: CommonStatus.active } });
    await client.monthlySettlement.create({ data: { settlementMonth: lockedMonth, status: SettlementStatus.locked, lockedAt: new Date(), lockedBy: adminUser.id, lockReason: 'task62 locked' } });
    await client.syncPlanningRun.create({ data: { settlementMonth: lockedMonth, status: SyncPlanningRunStatus.failed, lastAttemptAt: new Date(), blockedCount: 1, blockerCodes: ['MONTH_LOCKED'], failureCode: 'SAFE_FAILURE' } });
    await client.syncTask.createMany({ data: [
      baseTask(month, SyncTaskStatus.pending, { triggerType: SyncTaskTriggerType.scheduled, planningKey: 'task62:pending' }),
      baseTask(month, SyncTaskStatus.running, { triggerType: SyncTaskTriggerType.scheduled, planningKey: 'task62:running', leaseOwner: 'must-not-return', leaseExpiresAt: new Date(Date.now() - 60_000) }),
      baseTask(month, SyncTaskStatus.retry_wait, { triggerType: SyncTaskTriggerType.scheduled, planningKey: 'task62:retry', nextAttemptAt: new Date(Date.now() + 60_000) }),
      baseTask(month, SyncTaskStatus.failed, { triggerType: SyncTaskTriggerType.scheduled, planningKey: 'task62:failed', lastErrorCategory: SyncExecutionErrorCategory.NETWORK_ERROR, errorMessage: 'safe error' }),
      baseTask(month, SyncTaskStatus.pending, { triggerType: SyncTaskTriggerType.manual, planningKey: null }),
      baseTask(lockedMonth, SyncTaskStatus.failed, { triggerType: SyncTaskTriggerType.scheduled, planningKey: 'task62:locked', lastErrorCategory: SyncExecutionErrorCategory.MONTH_LOCKED, errorMessage: 'safe locked error' }),
    ] });
    await client.auditLog.create({ data: { actorUserId: adminUser.id, actorRole: 'super_admin', action: 'audit_log.export', objectType: 'audit_export', result: AuditResult.success } });
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  it('reads real counts without leaking sensitive fields or mutating rows', async () => {
    const before = await fingerprint();
    const result = await new SystemHealthService(client as never).getSystemHealth(new Date());
    const after = await fingerprint();

    expect(after).toEqual(before);
    expect(result.autoExecution).toMatchObject({
      pendingEligibleCount: 1,
      runningCount: 1,
      retryWaitingCount: 1,
      failedCount: 2,
      expiredRunningLeaseCount: 1,
    });
    expect(result.credentials).toMatchObject({ missingCredentialBlockerCount: 1 });
    expect(result.settlements).toMatchObject({ lockedMonthBlockedSyncTaskCount: 1 });
    expect(result.syncPlanning.lastResult).toMatchObject({ status: SyncPlanningRunStatus.failed, blockedCount: 1 });
    expect(result.audit).toMatchObject({ superAdminCount: 1, enabledSuperAdminCount: 1 });
    expect(JSON.stringify(result)).not.toMatch(/DATABASE_URL|leaseOwner|must-not-read|must-not-return|encryptedPayload|credentialPayload|token|passwordHash/i);
  });

  async function fingerprint() {
    return {
      tasks: await client.syncTask.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true, leaseOwner: true, updatedAt: true } }),
      credentials: await client.affiliateAccountCredential.findMany({ select: { id: true, updatedAt: true, encryptedPayload: true } }),
      audits: await client.auditLog.count(),
    };
  }

  function baseTask(settlementMonth: Date, status: SyncTaskStatus, data: Record<string, unknown>) {
    return {
      sourceType: SyncTaskSourceType.affiliate_income,
      taskType: SyncTaskType.affiliate_income,
      platform: SyncTaskPlatform.everflow,
      affiliateAccountId: accountId,
      settlementMonth,
      status,
      ...data,
    };
  }
});

function withSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}
