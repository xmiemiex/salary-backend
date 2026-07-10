import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import { PrismaClient, SyncTaskStatus, SyncTaskTriggerType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SyncAutoExecutionService } from './sync-auto-execution.service';
import { SyncTaskOperationsService } from './sync-task-operations.service';

const databaseDescribe = process.env.TASK59_DATABASE_TESTS === '1' ? describe : describe.skip;

databaseDescribe('sync task operations real PostgreSQL state transitions', () => {
  const baseUrl = process.env.DATABASE_URL!;
  const schema = `task59_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  const a = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  const b = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  const actor = { userId: '11111111-1111-4111-8111-111111111111', roleCode: 'finance', permissions: ['income.import', 'manual_card_spend.manage'] };
  const lowActor = { userId: '22222222-2222-4222-8222-222222222222', roleCode: 'limited', permissions: ['income.import'] };
  const oldEnv = { ...process.env };

  beforeAll(async () => {
    process.env.SYNC_AUTO_EXECUTION_ENABLED = 'true';
    process.env.SYNC_AUTO_EXECUTION_BATCH_SIZE = '10';
    process.env.SYNC_AUTO_EXECUTION_MAX_ATTEMPTS = '5';
    const command = process.platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm db:migrate'] } : { file: 'pnpm', args: ['db:migrate'] };
    execFileSync(command.file, command.args, { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' });
    await a.$connect(); await b.$connect();
    await a.adminUser.create({ data: { id: actor.userId, username: 'task59-admin', passwordHash: 'test-only-hash', displayName: 'Task59 Admin', status: 'active' } });
    await a.adminUser.create({ data: { id: lowActor.userId, username: 'task59-low', passwordHash: 'test-only-hash', displayName: 'Task59 Low', status: 'active' } });
    await a.cardProviderCredential.create({ data: { provider: 'airwallex', encryptedPayload: 'test-only', status: 'active' } });
  }, 60_000);

  afterAll(async () => {
    Object.keys(process.env).forEach((key) => { if (!(key in oldEnv)) delete process.env[key]; });
    Object.assign(process.env, oldEnv);
    await a.$disconnect(); await b.$disconnect();
    const cleanup = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.$disconnect();
  });

  function service(client: PrismaClient) {
    return new SyncTaskOperationsService(client as never, new AuditService(client as never));
  }

  function worker(client: PrismaClient) {
    return new SyncAutoExecutionService(client as never, new AuditService(client as never), { resolve: jest.fn() } as never, {} as never);
  }

  async function claim(client: PrismaClient, now = new Date()) {
    return (worker(client) as unknown as { claim(now: Date): Promise<Array<{ id: string; attemptCount: number }>> }).claim(now);
  }

  async function finishSuccess(workerInstance: SyncAutoExecutionService, id: string, claimRow: unknown) {
    return (workerInstance as unknown as { finishSuccess(id: string, claim: unknown, result: unknown): Promise<void> }).finishSuccess(id, claimRow, {
      successCount: 1,
      failedCount: 0,
      message: 'task59 controlled worker finish',
      resultPayload: { source: 'task59-controlled-worker' },
    });
  }

  async function task(month: string, data: Record<string, unknown> = {}) {
    return a.syncTask.create({
      data: {
        sourceType: 'card_spend',
        taskType: 'airwallex_card',
        platform: 'airwallex',
        provider: 'airwallex',
        settlementMonth: new Date(`${month}-01T00:00:00Z`),
        status: SyncTaskStatus.failed,
        triggerType: SyncTaskTriggerType.scheduled,
        planningKey: `task59:${month}:${randomUUID()}`,
        attemptCount: 2,
        lastErrorCategory: 'TIMEOUT',
        errorMessage: 'token=SECRET',
        resultPayload: { apiKey: 'SECRET', safe: true },
        ...data,
      },
    });
  }

  it('retry 与 worker 领取并发：只形成一个租约且不重复执行', async () => {
    const row = await task('2049-01');
    const [left, right, firstClaim, secondClaim] = await Promise.allSettled([
      service(a).requestRetry(row.id, { reason: 'retry' }, actor),
      service(b).requestRetry(row.id, { reason: 'retry' }, actor),
      claim(a),
      claim(b),
    ]);
    expect([left.status, right.status].filter((status) => status === 'fulfilled')).toHaveLength(1);
    const claimedIds = [firstClaim, secondClaim].flatMap((result) => result.status === 'fulfilled' ? result.value.map((item) => item.id) : []);
    expect(claimedIds.filter((id) => id === row.id).length).toBeLessThanOrEqual(1);
    const persisted = await a.syncTask.findUnique({ where: { id: row.id } });
    expect([SyncTaskStatus.pending, SyncTaskStatus.running]).toContain(persisted!.status);
    expect(persisted!.attemptCount).toBeGreaterThanOrEqual(2);
    expect(persisted!.attemptCount).toBeLessThanOrEqual(3);
    expect(await a.auditLog.count({ where: { objectId: row.id, action: 'sync_task.manual_retry_requested' } })).toBe(1);
  });

  it('cancel 与 worker 领取并发：最终状态一致且无双重领取', async () => {
    const row = await task('2049-02', { status: 'pending' });
    const [cancelResult, firstClaim, secondClaim] = await Promise.allSettled([
      service(a).cancel(row.id, { reason: 'cancel' }, actor),
      claim(a),
      claim(b),
    ]);
    const claimedIds = [firstClaim, secondClaim].flatMap((result) => result.status === 'fulfilled' ? result.value.map((item) => item.id) : []);
    expect(claimedIds.filter((id) => id === row.id).length).toBeLessThanOrEqual(1);
    const persisted = await a.syncTask.findUnique({ where: { id: row.id } });
    if (cancelResult.status === 'fulfilled') expect(persisted).toMatchObject({ status: 'cancelled', leaseOwner: null });
    else expect(persisted).toMatchObject({ status: 'running' });
  });

  it('cancel 并发双击：只更新一次且 cancelled 禁止 retry', async () => {
    const row = await task('2049-02', { status: 'retry_wait', nextAttemptAt: new Date(Date.now() + 60_000) });
    const [left, right] = await Promise.allSettled([
      service(a).cancel(row.id, { reason: 'cancel' }, actor),
      service(b).cancel(row.id, { reason: 'cancel' }, actor),
    ]);
    expect([left.status, right.status].filter((status) => status === 'fulfilled')).toHaveLength(1);
    expect(await a.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'cancelled', leaseOwner: null, leaseExpiresAt: null });
    await expect(service(a).requestRetry(row.id, {}, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('locked month retry 零写入并记录 retry_rejected_locked_month', async () => {
    const row = await task('2049-03');
    await a.monthlySettlement.create({ data: { settlementMonth: row.settlementMonth, status: 'locked' } });
    const before = await a.syncTask.findUnique({ where: { id: row.id } });
    await expect(service(a).requestRetry(row.id, {}, actor)).rejects.toMatchObject({ code: 'MONTH_LOCKED' });
    expect(await a.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: before!.status, attemptCount: before!.attemptCount, nextAttemptAt: before!.nextAttemptAt });
    expect(await a.auditLog.count({ where: { objectId: row.id, action: 'sync_task.retry_rejected_locked_month' } })).toBe(1);
  });

  it('missing credential retry 零写入', async () => {
    await a.cardProviderCredential.update({ where: { provider: 'airwallex' }, data: { status: 'disabled' } });
    const row = await task('2049-04');
    const before = await a.syncTask.findUnique({ where: { id: row.id } });
    await expect(service(a).requestRetry(row.id, {}, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await a.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: before!.status, attemptCount: before!.attemptCount, nextAttemptAt: before!.nextAttemptAt });
    await a.cardProviderCredential.update({ where: { provider: 'airwallex' }, data: { status: 'active' } });
  });

  it('active running lease 不能 cancel', async () => {
    const active = await task('2049-05', { status: 'running', leaseOwner: 'worker-a', leaseExpiresAt: new Date(Date.now() + 60_000) });
    await expect(service(a).cancel(active.id, {}, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await a.syncTask.findUnique({ where: { id: active.id } })).toMatchObject({ status: 'running', leaseOwner: 'worker-a' });
  });

  it('expired running lease 可以 cancel，旧 worker 不能写回覆盖 cancelled', async () => {
    const workerInstance = worker(a);
    const expired = await task('2049-06', { status: 'running', leaseOwner: 'worker-b', leaseExpiresAt: new Date(Date.now() - 60_000) });
    const recoveredClaims = await (workerInstance as unknown as { claim(now: Date): Promise<Array<{ id: string; attemptCount: number }>> }).claim(new Date());
    const claimRow = recoveredClaims.find((item) => item.id === expired.id);
    expect(claimRow).toBeDefined();
    await a.syncTask.update({ where: { id: expired.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    await service(a).cancel(expired.id, {}, actor);
    await finishSuccess(workerInstance, expired.id, claimRow);
    expect(await a.syncTask.findUnique({ where: { id: expired.id } })).toMatchObject({ status: 'cancelled', leaseOwner: null });
  });

  it('forbids retry or cancel for completed tasks', async () => {
    const row = await task('2049-07', { status: 'completed' });
    await expect(service(a).requestRetry(row.id, {}, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service(a).cancel(row.id, {}, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await a.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'completed' });
  });

  it('abnormal-only list includes failed, retry_wait and expired running but not pending/completed', async () => {
    const failed = await task('2049-08');
    const retry = await task('2049-08', { status: 'retry_wait', planningKey: `task59:retry:${randomUUID()}` });
    const expired = await task('2049-08', { status: 'running', leaseOwner: 'expired', leaseExpiresAt: new Date(Date.now() - 1000), planningKey: `task59:expired:${randomUUID()}` });
    const pending = await task('2049-08', { status: 'pending', planningKey: `task59:pending:${randomUUID()}` });
    const completed = await task('2049-08', { status: 'completed', planningKey: `task59:completed:${randomUUID()}` });
    const result = await service(a).list({ settlementMonth: '2049-08', abnormalOnly: 'true', pageSize: '20' });
    const ids = result.items.map((item) => item.taskId);
    expect(ids).toEqual(expect.arrayContaining([failed.id, retry.id, expired.id]));
    expect(ids).not.toEqual(expect.arrayContaining([pending.id, completed.id]));
  });

  it('retry 后进入 pending，保留 attemptCount，并可被任务58 worker 领取后完成', async () => {
    const row = await task('2049-10', { status: 'failed', attemptCount: 4 });
    await service(a).requestRetry(row.id, { reason: 'retry worker closure' }, actor);
    expect(await a.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'pending', attemptCount: 4 });
    const workerInstance = worker(a);
    const claimed = await (workerInstance as unknown as { claim(now: Date): Promise<Array<{ id: string; attemptCount: number }>> }).claim(new Date());
    const claimRow = claimed.find((item) => item.id === row.id);
    expect(claimRow).toBeDefined();
    expect(await a.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'running', attemptCount: 5 });
    await finishSuccess(workerInstance, row.id, claimRow);
    expect(await a.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'completed', successCount: 1, message: 'task59 controlled worker finish' });
  });

  it('cancel 后 worker 永不领取', async () => {
    const row = await task('2049-11', { status: 'pending' });
    await service(a).cancel(row.id, { reason: 'cancel before worker' }, actor);
    const claimedIds = (await claim(a)).map((item) => item.id);
    expect(claimedIds).not.toContain(row.id);
    expect(await a.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'cancelled' });
  });

  it('审计与详情无敏感字段', async () => {
    const row = await task('2049-09');
    await service(a).requestRetry(row.id, { reason: 'safe' }, actor);
    const detail = await service(a).detail(row.id);
    expect(JSON.stringify(detail)).not.toMatch(/SECRET|apiKey|token|leaseOwner|lease_owner|encryptedPayload/i);
    const audits = await a.auditLog.findMany({ where: { objectId: row.id } });
    expect(JSON.stringify(audits)).not.toMatch(/SECRET|apiKey|encryptedPayload|DATABASE_URL/i);
  });

  it('低权限 API 403 后 session 仍有效', async () => {
    const session = await a.adminSession.create({
      data: {
        adminUserId: lowActor.userId,
        tokenHash: 'task59-low-session-token-hash',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const row = await task('2049-12', { status: 'failed' });
    await expect(service(a).requestRetry(row.id, {}, lowActor)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await a.adminSession.findUnique({ where: { id: session.id } })).toMatchObject({ revokedAt: null });
    expect(await a.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'failed' });
  });
});

function withSchema(url: string, schema: string) {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}
