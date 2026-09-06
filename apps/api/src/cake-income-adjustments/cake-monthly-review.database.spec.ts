import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { MonthLockService } from '../month-lock/month-lock.service';
import { CakeIncomeAdjustmentsService } from './cake-income-adjustments.service';
import { readCakeMonthlyReview } from './cake-monthly-review';

const integration = process.env.CAKE_REVIEW_DATABASE_TESTS === '1' ? describe : describe.skip;
integration('CAKE monthly review isolated PostgreSQL', () => {
  jest.setTimeout(180000);
  const root = path.resolve(__dirname, '../../../..');
  const schema = `cake_review_${randomUUID().replace(/-/g, '')}`;
  const month = new Date('2026-07-01');
  let admin: PrismaClient, db: PrismaClient, service: CakeIncomeAdjustmentsService, audit: AuditService, lock: MonthLockService;
  let accountId: string, baseId: string, actor: { userId: string; roleCode: string; permissions: string[] };
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== 'localhost' || url.port !== '35439') throw new Error('Only dedicated local PostgreSQL is allowed');
    admin = new PrismaClient(); await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('schema', schema);
    execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], { cwd: root, env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe' });
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const user = await db.adminUser.create({ data: { username: 'cake-review-fixture', displayName: 'Test', passwordHash: 'not-for-login' } });
    actor = { userId: user.id, roleCode: 'super_admin', permissions: ['income.import'] };
    const account = await db.affiliateAccount.create({ data: { platform: 'cake', accountCode: 'review-test' } }); accountId = account.id;
    const base = await db.incomeRecord.create({ data: { source: 'cake', settlementMonth: month, affiliateAccountId: accountId, subField: 'sub1', subValue: 'fixture', incomeUsd: '100', status: 'confirmed' } }); baseId = base.id;
    audit = new AuditService(db as never); lock = new MonthLockService(db as never, audit); service = new CakeIncomeAdjustmentsService(db as never, lock, audit);
  });
  afterAll(async () => { await db?.$disconnect(); if (admin) { await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.$disconnect(); } });
  const input = () => ({ affiliateAccountId: accountId, settlementMonth: '2026-07' });
  it('confirms/cancels with audit, preserves identical refreshes and detects changes without altering income', async () => {
    const initial = await readCakeMonthlyReview(db, accountId, month); expect(initial.status).toBe('unreviewed');
    const before = await db.incomeRecord.findMany();
    const result = await service.confirmMonthlyReview({ ...input(), baseFingerprint: initial.baseFingerprint }, actor);
    expect(result.review.status).toBe('confirmed_no_adjustment'); expect(await db.incomeRecord.findMany()).toEqual(before);
    await db.incomeRecord.update({ where: { id: baseId }, data: { incomeUsd: '100.000' } });
    expect((await readCakeMonthlyReview(db, accountId, month)).status).toBe('confirmed_no_adjustment');
    await db.incomeRecord.update({ where: { id: baseId }, data: { incomeUsd: '101' } });
    expect((await readCakeMonthlyReview(db, accountId, month)).status).toBe('needs_review');
    await expect(service.confirmMonthlyReview({ ...input(), baseFingerprint: initial.baseFingerprint }, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await service.cancelMonthlyReview(input(), actor)).review.status).toBe('unreviewed');
    expect(await db.auditLog.count({ where: { action: { startsWith: 'cake_monthly_review.' }, result: 'success' } })).toBe(2);
    expect(await db.incomeRecord.count()).toBe(1);
    expect((await readCakeMonthlyReview(db, accountId, new Date('2026-08-01'))).status).toBe('unreviewed');
  });
  it('rolls back the confirmation if audit persistence fails', async () => {
    const failAudit = { success: jest.fn().mockRejectedValue(new Error('simulated audit write failure')) };
    const failingService = new CakeIncomeAdjustmentsService(db as never, lock, failAudit as never);
    const review = await readCakeMonthlyReview(db, accountId, month);
    await expect(failingService.confirmMonthlyReview({ ...input(), baseFingerprint: review.baseFingerprint }, actor)).rejects.toThrow('simulated audit');
    expect(await db.cakeMonthlyIncomeReview.count()).toBe(0);
  });
  it('audits a month lock committed between the initial check and confirmation', async () => {
    const selected = new Date('2026-08-01');
    const review = await readCakeMonthlyReview(db, accountId, selected);
    let writerReady!: () => void, releaseWriter!: () => void, checked!: () => void;
    const ready = new Promise<void>(resolve => { writerReady = resolve; });
    const release = new Promise<void>(resolve => { releaseWriter = resolve; });
    const checkedBeforeCommit = new Promise<void>(resolve => { checked = resolve; });
    const writer = db.$transaction(async tx => {
      await tx.monthlySettlement.create({ data: { settlementMonth: selected, status: 'locked' } });
      writerReady(); await release;
    });
    await ready;
    const observedLock = { assertWritable: async (...args: Parameters<MonthLockService['assertWritable']>) => { await lock.assertWritable(...args); checked(); } };
    const concurrent = new CakeIncomeAdjustmentsService(db as never, observedLock as never, audit);
    const confirmation = concurrent.confirmMonthlyReview({ affiliateAccountId: accountId, settlementMonth: '2026-08', baseFingerprint: review.baseFingerprint }, actor);
    const denied = expect(confirmation).rejects.toMatchObject({ code: 'MONTH_LOCKED' });
    await checkedBeforeCommit; releaseWriter(); await writer; await denied;
    expect(await db.cakeMonthlyIncomeReview.count({ where: { settlementMonth: selected } })).toBe(0);
    expect(await db.auditLog.count({ where: { settlementMonth: selected, action: 'cake_monthly_review.confirm', result: 'failure' } })).toBe(1);
  });

  it('blocks confirmation/cancellation under month lock at service and database boundaries', async () => {
    const review = await readCakeMonthlyReview(db, accountId, month);
    await service.confirmMonthlyReview({ ...input(), baseFingerprint: review.baseFingerprint }, actor);
    await db.monthlySettlement.create({ data: { settlementMonth: month, status: 'locked' } });
    await expect(service.confirmMonthlyReview({ ...input(), baseFingerprint: review.baseFingerprint }, actor)).rejects.toMatchObject({ code: 'MONTH_LOCKED' });
    await expect(service.cancelMonthlyReview(input(), actor)).rejects.toMatchObject({ code: 'MONTH_LOCKED' });
    await expect(db.cakeMonthlyIncomeReview.deleteMany()).rejects.toThrow('MONTH_LOCKED');
    expect(await db.cakeMonthlyIncomeReview.count()).toBe(1);
    expect(await db.auditLog.count({ where: { settlementMonth: month, action: { startsWith: 'cake_monthly_review.' }, result: 'failure' } })).toBe(2);
  });
});
