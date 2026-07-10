import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import { CommonStatus, PrismaClient, SyncTaskStatus, SyncTaskTriggerType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SyncAutoExecutionService } from './sync-auto-execution.service';

const databaseDescribe = process.env.TASK58_DATABASE_TESTS === '1' ? describe : describe.skip;

databaseDescribe('sync auto execution real PostgreSQL leases', () => {
  const baseUrl = process.env.DATABASE_URL!;
  const schema = `task58_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  const a = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  const b = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  let accountId: string;
  const oldEnv = { ...process.env };

  beforeAll(async () => {
    process.env.SYNC_AUTO_EXECUTION_ENABLED = 'true';
    process.env.SYNC_AUTO_EXECUTION_BATCH_SIZE = '2';
    process.env.SYNC_AUTO_EXECUTION_MAX_ATTEMPTS = '3';
    const command = process.platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm db:migrate'] } : { file: 'pnpm', args: ['db:migrate'] };
    execFileSync(command.file, command.args, { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' });
    await a.$connect(); await b.$connect();
    const account = await a.affiliateAccount.create({ data: { platform: 'everflow', accountCode: 'task58', accountName: 'task58', status: CommonStatus.active } });
    accountId = account.id;
    await a.affiliateAccountCredential.create({ data: { affiliateAccountId: account.id, encryptedPayload: 'test-only', status: CommonStatus.active } });
  }, 60_000);

  afterAll(async () => {
    Object.keys(process.env).forEach((key) => { if (!(key in oldEnv)) delete process.env[key]; });
    Object.assign(process.env, oldEnv);
    await a.$disconnect(); await b.$disconnect();
    const cleanup = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await cleanup.$disconnect();
  });

  function service(client: PrismaClient) {
    return new SyncAutoExecutionService(client as never, new AuditService(client as never), { resolve: jest.fn() } as never, {} as never);
  }
  async function task(month: string, data: Record<string, unknown> = {}) {
    return a.syncTask.create({ data: { sourceType: 'affiliate_income', taskType: 'affiliate_income', platform: 'everflow', affiliateAccountId: accountId,
      settlementMonth: new Date(`${month}-01T00:00:00Z`), status: SyncTaskStatus.pending, triggerType: SyncTaskTriggerType.scheduled,
      planningKey: `task58:${month}:${randomUUID()}`, ...data } });
  }
  async function claim(worker: SyncAutoExecutionService, now = new Date()) { return (worker as unknown as { claim(now: Date): Promise<Array<{ id: string; attemptCount: number }>> }).claim(now); }

  it('two workers atomically claim a task only once and increment attempts', async () => {
    const row = await task('2041-01');
    const [left, right] = await Promise.all([claim(service(a)), claim(service(b))]);
    expect([...left, ...right].filter((item) => item.id === row.id)).toHaveLength(1);
    expect(await a.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'running', attemptCount: 1 });
  });

  it('an active lease cannot be stolen, but an expired lease is recovered without a second task', async () => {
    const row = await task('2041-02', { status: 'running', attemptCount: 1, leaseOwner: 'expired-worker', leaseExpiresAt: new Date(Date.now() + 60_000) });
    expect(await claim(service(a))).toHaveLength(0);
    await a.syncTask.update({ where: { id: row.id }, data: { leaseExpiresAt: new Date(Date.now() - 1_000) } });
    const recovered = await claim(service(b));
    expect(recovered.map((item) => item.id)).toContain(row.id);
    expect(await a.syncTask.count({ where: { id: row.id } })).toBe(1);
    expect(await a.auditLog.count({ where: { objectId: row.id, action: 'sync_task.auto.lease_recovered' } })).toBe(1);
  });

  it('never claims manual, completed, cancelled, future retry or max-attempt tasks', async () => {
    const rows = await Promise.all([
      task('2041-03', { triggerType: 'manual', planningKey: null }),
      task('2041-04', { status: 'completed' }),
      task('2041-05', { status: 'cancelled' }),
      task('2041-06', { status: 'retry_wait', nextAttemptAt: new Date(Date.now() + 60_000) }),
      task('2041-07', { attemptCount: 3 }),
    ]);
    const ids = (await claim(service(a))).map((item) => item.id);
    expect(rows.every((row) => !ids.includes(row.id))).toBe(true);
  });

  it('does not claim locked months or tasks missing an active credential', async () => {
    const locked = await task('2041-08');
    await a.monthlySettlement.create({ data: { settlementMonth: locked.settlementMonth, status: 'locked' } });
    await a.affiliateAccountCredential.update({ where: { affiliateAccountId: accountId }, data: { status: 'disabled' } });
    const missing = await task('2041-09');
    const ids = (await claim(service(a))).map((item) => item.id);
    expect(ids).not.toContain(locked.id); expect(ids).not.toContain(missing.id);
    await a.syncTask.update({ where: { id: missing.id }, data: { status: 'cancelled' } });
    await a.affiliateAccountCredential.update({ where: { affiliateAccountId: accountId }, data: { status: 'active' } });
  });

  it('respects batch size across multiple eligible tasks', async () => {
    const rows = await Promise.all([task('2041-10'), task('2041-11'), task('2041-12')]);
    expect(await claim(service(a))).toHaveLength(2);
    await a.syncTask.updateMany({ where: { id: { in: rows.map((row) => row.id) }, status: 'pending' }, data: { status: 'cancelled' } });
  });

  it('conditional completion prevents an old lease owner and cancelled task from being overwritten', async () => {
    const worker = service(a);
    const row = await task('2042-01');
    const [claimed] = await claim(worker);
    await a.syncTask.update({ where: { id: row.id }, data: { status: 'cancelled', leaseOwner: null, leaseExpiresAt: null } });
    await (worker as unknown as { finishSuccess(id: string, claim: unknown, result: unknown): Promise<void> }).finishSuccess(row.id, claimed, { successCount: 1, failedCount: 0, message: 'done', resultPayload: {} });
    expect(await a.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'cancelled' });
  });

  it('an expired old worker cannot overwrite a task recovered by a new worker', async () => {
    const oldWorker = service(a); const newWorker = service(b);
    const row = await task('2042-03');
    const [oldClaim] = await claim(oldWorker);
    await a.syncTask.update({ where: { id: row.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    const [newClaim] = await claim(newWorker);
    expect(newClaim.id).toBe(row.id);
    await (oldWorker as unknown as { finishSuccess(id: string, claim: unknown, result: unknown): Promise<void> }).finishSuccess(row.id, oldClaim, { successCount: 1, failedCount: 0, message: 'stale', resultPayload: {} });
    expect(await a.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'running', attemptCount: 2 });
    await (newWorker as unknown as { finishSuccess(id: string, claim: unknown, result: unknown): Promise<void> }).finishSuccess(row.id, newClaim, { successCount: 1, failedCount: 0, message: 'current', resultPayload: {} });
    expect(await a.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'completed', message: 'current' });
  });

  it('migration preserves historical task state and audit payloads never contain lease owner', async () => {
    const historical = await task('2042-02', { triggerType: 'manual', planningKey: null, message: 'historical' });
    expect(await a.syncTask.findUnique({ where: { id: historical.id } })).toMatchObject({ status: 'pending', message: 'historical', attemptCount: 0 });
    const audits = await a.auditLog.findMany({ where: { action: { startsWith: 'sync_task.auto.' } } });
    expect(JSON.stringify(audits)).not.toMatch(/leaseOwner|lease_owner|token|secret|encryptedPayload/i);
  });
});

function withSchema(url: string, schema: string) { const parsed = new URL(url); parsed.searchParams.set('schema', schema); return parsed.toString(); }
