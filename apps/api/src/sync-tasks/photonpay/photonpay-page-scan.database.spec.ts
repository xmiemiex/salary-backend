import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PhotonPayPageScan, PhotonPayPageState } from './photonpay-page-scan';
import { SyncAdapterContext } from '../sync-adapter';
import { SyncAutoExecutionService } from '../sync-auto-execution.service';

const dbDescribe = process.env.LIVE_PAGE_SCAN_DATABASE_TESTS === '1' ? describe : describe.skip;
dbDescribe('PhotonPay durable page state on isolated PostgreSQL', () => {
  const schema = `page_scan_${randomUUID().replaceAll('-', '')}`;
  const base = process.env.DATABASE_URL!;
  let root: PrismaClient, db: PrismaClient;
  const month = new Date('2026-08-01');
  const state: PhotonPayPageState = { version: 1, windowIndex: 2, nextPage: 17, coverageStartedAt: '2026-09-05T00:00:00Z', successCount: 20, failedCount: 0, stats: { providerUsdDebitAmountTotal: '123.456789' }, seen: ['abc'] };
  beforeAll(async () => {
    const target = new URL(base);
    if (target.hostname !== 'localhost' || target.port !== '35439' || !target.pathname.startsWith('/monthly_finance')) throw new Error('ISOLATED_DATABASE_REQUIRED');
    root = new PrismaClient(); await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    target.searchParams.set('schema', schema);
    const cwd = path.resolve(__dirname, '../../../../..');
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd, env: { ...process.env, DATABASE_URL: target.toString() }, stdio: 'pipe' });
    db = new PrismaClient({ datasources: { db: { url: target.toString() } } });
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); await root?.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await root?.$disconnect(); });
  async function task(owner: string): Promise<SyncAdapterContext> {
    const record = await db.syncTask.create({ data: { settlementMonth: month, sourceType: 'card_spend', taskType: 'photonpay_card', platform: 'photonpay', provider: 'photonpay', status: 'running', attemptCount: 1, leaseOwner: owner, leaseExpiresAt: new Date(Date.now() + 60000) } });
    return { ...record, taskId: record.id, provider: 'photonpay', durablePageScan: { leaseOwner: owner, attemptCount: 1 }, credential: { credentialId: 'test', hasCredential: true, maskedPayload: {} } } as SyncAdapterContext;
  }
  it('persists across task replacement, invalidates changed scope, and rejects stale lease writes/deletes', async () => {
    const a = await task('worker-a'), first = new PhotonPayPageScan(db as never, a, { credential: 'test-a', month: '2026-08' });
    await first.save(state); expect(await first.load()).toEqual(state);
    await db.syncTask.update({ where: { id: a.taskId }, data: { leaseExpiresAt: new Date(0) } });
    const b = await task('worker-b'), replacement = new PhotonPayPageScan(db as never, b, { credential: 'test-a', month: '2026-08' });
    expect(await replacement.load()).toEqual(state);
    expect(await new PhotonPayPageScan(db as never, b, { credential: 'changed', month: '2026-08' }).load()).toBeNull();
    await replacement.save({ ...state, nextPage: 18 });
    await expect(first.save({ ...state, nextPage: 99 })).rejects.toMatchObject({ category: 'TIMEOUT' });
    await expect(first.clear()).rejects.toMatchObject({ category: 'TIMEOUT' });
    expect((await replacement.load())?.nextPage).toBe(18);
    await db.syncTask.update({ where: { id: b.taskId }, data: { attemptCount: 2 } });
    await expect(replacement.clear()).rejects.toMatchObject({ category: 'TIMEOUT' });
    const nextAttempt = new PhotonPayPageScan(db as never, { ...b, durablePageScan: { leaseOwner: 'worker-b', attemptCount: 2 } }, { credential: 'test-a', month: '2026-08' });
    await nextAttempt.clear(); expect(await nextAttempt.load()).toBeNull();
  });
  it('rejects late success and failure from an older attempt in the same executor instance', async () => {
    const audit = { success: jest.fn(), failure: jest.fn() };
    const executor = new SyncAutoExecutionService(db as never, audit as never, {} as never, {} as never);
    const internal = executor as unknown as { instanceId: string; finishSuccess: (...args: unknown[]) => Promise<void>; finishFailure: (...args: unknown[]) => Promise<void> };
    const context = await task(internal.instanceId);
    await db.syncTask.update({ where: { id: context.taskId }, data: { attemptCount: 2 } });
    const claim = { id: context.taskId, sourceType: 'card_spend', platform: 'photonpay', provider: 'photonpay', settlementMonth: month, attemptCount: 1 };
    const result = { successCount: 1, failedCount: 0, message: 'test', resultPayload: {} };
    await internal.finishSuccess(context.taskId, claim, result);
    await internal.finishFailure(context.taskId, claim, 'BUSINESS_REJECTED', 'late old attempt', result);
    expect((await db.syncTask.findUniqueOrThrow({ where: { id: context.taskId } })).status).toBe('running');
    expect(audit.success).not.toHaveBeenCalled(); expect(audit.failure).not.toHaveBeenCalled();
    await internal.finishSuccess(context.taskId, { ...claim, attemptCount: 2 }, result);
    expect((await db.syncTask.findUniqueOrThrow({ where: { id: context.taskId } })).status).toBe('completed');
    expect(audit.success).toHaveBeenCalledTimes(1);
  });
});
