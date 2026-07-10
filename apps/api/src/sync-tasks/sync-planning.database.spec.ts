import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import { CommonStatus, PrismaClient, SyncTaskStatus, SyncTaskTriggerType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SyncPlanningService } from './sync-planning.service';
import { SyncPlannerScheduler } from './sync-planner.scheduler';

const databaseDescribe = process.env.TASK57_DATABASE_TESTS === '1' ? describe : describe.skip;

databaseDescribe('sync planning real PostgreSQL concurrency', () => {
  const baseUrl = process.env.DATABASE_URL!;
  const schema = `task57_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  const a = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  const b = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  const month = '2037-06';
  let actorId: string;

  beforeAll(async () => {
    const command = process.platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm db:migrate'] } : { file: 'pnpm', args: ['db:migrate'] };
    execFileSync(command.file, command.args, { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' });
    await a.$connect(); await b.$connect();
    const role = await a.role.create({ data: { code: 'task57', name: 'task57' } });
    const actor = await a.adminUser.create({ data: { username: 'task57', displayName: 'task57', passwordHash: 'test-only', roles: { create: { roleId: role.id } } } });
    actorId = actor.id;
    const account = await a.affiliateAccount.create({ data: { platform: 'everflow', accountCode: 'task57', accountName: 'Blitz', status: CommonStatus.active } });
    await a.affiliateAccountCredential.create({ data: { affiliateAccountId: account.id, encryptedPayload: 'test-only-never-decrypted', status: CommonStatus.active } });
    await a.cardProviderCredential.createMany({ data: [
      { provider: 'airwallex', encryptedPayload: 'test-only-never-decrypted', status: CommonStatus.active },
      { provider: 'photonpay', encryptedPayload: 'test-only-never-decrypted', status: CommonStatus.active },
    ] });
  }, 60_000);
  afterAll(async () => {
    await a.$disconnect(); await b.$disconnect();
    const cleanup = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await cleanup.$disconnect();
  });

  function service(client: PrismaClient, audit = new AuditService(client as never)) { return new SyncPlanningService(client as never, audit); }
  const actor = () => ({ userId: actorId, roleCode: 'task57', permissions: ['income.import'] });

  it('preview performs zero business or audit writes', async () => {
    const before = [await a.syncTask.count(), await a.auditLog.count()];
    await service(a).preview(month);
    expect([await a.syncTask.count(), await a.auditLog.count()]).toEqual(before);
  });
  it('two manual requests create exactly one logical set and pending tasks', async () => {
    const results = await Promise.all([service(a).generate(month, actor(), SyncTaskTriggerType.manual), service(b).generate(month, actor(), SyncTaskTriggerType.manual)]);
    expect(results.reduce((sum, result) => sum + result.summary.createdCount, 0)).toBe(3);
    expect(await a.syncTask.count()).toBe(3);
    expect((await a.syncTask.findMany()).every((task) => task.status === SyncTaskStatus.pending && task.requestedBy === actorId && task.triggerType === SyncTaskTriggerType.manual)).toBe(true);
  });
  it('manual and scheduled concurrency plus two simulated schedulers cannot duplicate', async () => {
    const next = '2037-07';
    await Promise.all([service(a).generate(next, actor(), SyncTaskTriggerType.manual), service(b).generate(next, null, SyncTaskTriggerType.scheduled)]);
    expect(await a.syncTask.count({ where: { settlementMonth: new Date('2037-07-01T00:00:00Z') } })).toBe(3);
    const next2 = '2037-08';
    await Promise.all([service(a).generate(next2, null, SyncTaskTriggerType.scheduled), service(b).generate(next2, null, SyncTaskTriggerType.scheduled)]);
    const scheduled = await a.syncTask.findMany({ where: { settlementMonth: new Date('2037-08-01T00:00:00Z') } });
    expect(scheduled).toHaveLength(3);
    expect(scheduled.every((task) => task.requestedBy === null && task.triggerType === SyncTaskTriggerType.scheduled)).toBe(true);
  });
  it('two application scheduler instances claim one run and compensate only the current target month', async () => {
    const previous = process.env.SYNC_PLANNER_ENABLED;
    process.env.SYNC_PLANNER_ENABLED = 'true';
    try {
      const schedulerA = new SyncPlannerScheduler(a as never, service(a));
      const schedulerB = new SyncPlannerScheduler(b as never, service(b));
      const now = new Date('2037-12-10T01:00:00.000Z');
      const results = await Promise.all([schedulerA.check(now), schedulerB.check(now)]);
      expect(results.filter((result) => result.executed)).toHaveLength(1);
      expect(await a.syncTask.count({ where: { settlementMonth: new Date('2037-11-01T00:00:00Z') } })).toBe(3);
      expect(await a.syncTask.count({ where: { settlementMonth: { lt: new Date('2037-06-01T00:00:00Z') } } })).toBe(0);
      expect(await a.syncPlanningRun.findUnique({ where: { settlementMonth: new Date('2037-11-01T00:00:00Z') } })).toMatchObject({ status: 'succeeded' });
    } finally {
      if (previous === undefined) delete process.env.SYNC_PLANNER_ENABLED; else process.env.SYNC_PLANNER_ENABLED = previous;
    }
  });
  it('rolls back every task when the batch audit fails', async () => {
    const failingAudit = { success: jest.fn().mockRejectedValue(new Error('injected audit failure')) };
    await expect(service(a, failingAudit as never).generate('2037-09', actor(), SyncTaskTriggerType.manual)).rejects.toThrow('injected audit failure');
    expect(await a.syncTask.count({ where: { settlementMonth: new Date('2037-09-01T00:00:00Z') } })).toBe(0);
  });
  it('locked month creates zero tasks, while historical tasks remain untouched', async () => {
    const historical = await a.syncTask.findFirstOrThrow();
    await a.monthlySettlement.create({ data: { settlementMonth: new Date('2037-10-01T00:00:00Z'), status: 'locked' } });
    await expect(service(a).generate('2037-10', actor(), SyncTaskTriggerType.manual)).rejects.toMatchObject({ code: 'MONTH_LOCKED' });
    expect(await a.syncTask.count({ where: { settlementMonth: new Date('2037-10-01T00:00:00Z') } })).toBe(0);
    expect(await a.syncTask.findUnique({ where: { id: historical.id } })).toMatchObject({ id: historical.id, status: historical.status });
  });
});

function withSchema(url: string, schema: string) { const parsed = new URL(url); parsed.searchParams.set('schema', schema); return parsed.toString(); }
