import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { MonthlyFinanceService } from './monthly-finance.service';
import { AuditService } from '../audit/audit.service';
import { MonthLockService } from '../month-lock/month-lock.service';
import { CakeIncomeAdjustmentsService } from '../cake-income-adjustments/cake-income-adjustments.service';
import { readCakeMonthlyReview } from '../cake-income-adjustments/cake-monthly-review';

const integration = process.env.MANUAL_BATCH_DATABASE_TESTS === '1' ? describe : describe.skip;
integration('manual monthly total and transactional CAKE batch (isolated PostgreSQL)', () => {
  jest.setTimeout(120000);
  let root: PrismaClient, db: PrismaClient, audit: AuditService, finance: MonthlyFinanceService, cake: CakeIncomeAdjustmentsService;
  let actor: { userId: string; roleCode: string; permissions: string[] };
  const schema = `manual_batch_${randomUUID().replace(/-/g, '')}`, month = new Date('2026-08-01');
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== 'localhost' || url.port !== '35439') throw Error('ISOLATED_ONLY');
    root = new PrismaClient(); await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); url.searchParams.set('schema', schema);
    const projectRoot = path.resolve(__dirname, '../../../..');
    execFileSync(process.execPath, [path.join(projectRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], { cwd: projectRoot, env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe' });
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    actor = { userId: (await db.adminUser.create({ data: { username: 'isolated-batch', displayName: 'Test', passwordHash: 'not-a-login' } })).id, roleCode: 'super_admin', permissions: ['income.import'] };
    audit = new AuditService(db as never); finance = new MonthlyFinanceService(db as never, audit);
    cake = new CakeIncomeAdjustmentsService(db as never, new MonthLockService(db as never, audit), audit);
    await db.monthlyCardProviderFeeRate.create({ data: { settlementMonth: month, provider: 'photonpay', feeRate: '0', createdBy: actor.userId } });
  });
  afterAll(async () => { await db?.$disconnect(); if (root) { await root.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await root.$disconnect(); } });
  const employee = () => db.employee.create({ data: { employeeCode: randomUUID(), name: 'Isolated', businessSubId: randomUUID() } });
  async function drafts() {
    const owner = await employee(), account = await db.affiliateAccount.create({ data: { platform: 'cake', accountCode: randomUUID() } });
    const result = [];
    for (const [index, value] of ['100.1', '200.2'].entries()) {
      const subValue = 'SUB-' + index;
      await db.subIdMapping.create({ data: { employeeId: owner.id, affiliateAccountId: account.id, subField: 'sub1', subValue, effectiveMonth: month } });
      await db.incomeRecord.create({ data: { employeeId: owner.id, affiliateAccountId: account.id, settlementMonth: month, source: 'cake', subField: 'sub1', subValue, incomeUsd: value, status: 'confirmed' } });
      result.push(await cake.saveDraft({ affiliateAccountId: account.id, settlementMonth: '2026-08', subValue, actualRevenueUsd: index ? '205.2' : '105.1', reason: 'Isolated batch test' }, actor));
    }
    return { account, owner, rows: result, body: { affiliateAccountId: account.id, settlementMonth: '2026-08', requestId: randomUUID(), items: result.map(row => ({ id: row.id, updatedAt: row.updatedAt.toISOString() })) } };
  }

  it('adds and edits only selected manual entries, retaining other rows and metadata; recomputes monthly totals and ROI', async () => {
    const owner = await employee(), other = await employee();
    const account = await db.affiliateAccount.create({ data: { platform: 'cake', accountCode: randomUUID() } });
    const first = await db.incomeRecord.create({ data: { employeeId: owner.id, settlementMonth: month, source: 'manual', incomeUsd: '30.1', status: 'confirmed', rawData: { reason: 'original' } } });
    const second = await db.incomeRecord.create({ data: { employeeId: owner.id, settlementMonth: month, source: 'legacy-manual', incomeUsd: '20.2', status: 'confirmed' } });
    const untouched = await Promise.all([
      db.incomeRecord.create({ data: { employeeId: owner.id, settlementMonth: month, affiliateAccountId: account.id, source: 'cake', incomeUsd: '100', status: 'confirmed' } }),
      db.incomeRecord.create({ data: { employeeId: owner.id, settlementMonth: month, affiliateAccountId: account.id, source: 'cake_adjustment', incomeUsd: '5', status: 'confirmed' } }),
      db.incomeRecord.create({ data: { employeeId: other.id, settlementMonth: month, source: 'manual', incomeUsd: '7', status: 'confirmed' } }),
      db.incomeRecord.create({ data: { employeeId: owner.id, settlementMonth: new Date('2026-07-01'), source: 'manual', incomeUsd: '8', status: 'confirmed' } }),
    ]);
    await db.cardSpendEvent.create({ data: { employeeId: owner.id, settlementMonth: month, provider: 'photonpay', cardId: 'isolated', spendUsd: '10', transactionAt: month, status: 'confirmed' } });
    await finance.saveManualIncome('2026-08', owner.id, '10.1', { id: first.id, expectedUpdatedAt: first.updatedAt.toISOString() }, actor);
    expect(await db.incomeRecord.findUnique({ where: { id: first.id } })).toMatchObject({ rawData: first.rawData, source: first.source, status: 'confirmed' });
    expect((await db.incomeRecord.findUniqueOrThrow({ where: { id: first.id } })).incomeUsd.toString()).toBe('10.1');
    expect(await db.incomeRecord.findUnique({ where: { id: second.id } })).toEqual(second);
    for (const row of untouched) expect(await db.incomeRecord.findUnique({ where: { id: row.id } })).toEqual(row);
    const requestId = randomUUID();
    const added = await finance.saveManualIncome('2026-08', owner.id, '9.7', { requestId, reason: 'New income' }, actor);
    const row = (await finance.read('2026-08')).rows.find(r => r.key === owner.id)!;
    expect(row).toMatchObject({ otherIncome: '40', totalIncome: '145', profit: '135', margin: '1350.00' });
    expect((await finance.manualIncome('2026-08', owner.id, actor)).items).toHaveLength(3);
    const count = await db.incomeRecord.count();
    expect(await finance.saveManualIncome('2026-08', owner.id, '9.7', { requestId, reason: 'New income' }, actor)).toMatchObject({ reused: true });
    expect(await db.incomeRecord.count()).toBe(count);
    const addedRow = await db.incomeRecord.findUniqueOrThrow({ where: { id: added.id } });
    await finance.saveManualIncome('2026-08', owner.id, '0', { id: added.id, expectedUpdatedAt: addedRow.updatedAt.toISOString() }, actor);
    expect((await finance.read('2026-08')).rows.find(r => r.key === owner.id)?.otherIncome).toBe('30.3');
    await finance.refresh('2026-08', actor, 'photonpay'); // No credential: creates only a terminal failure, no supplier execution.
    expect((await finance.read('2026-08')).rows.find(r => r.key === owner.id)?.otherIncome).toBe('30.3');
  });

  it('rejects stale or out-of-scope entries, API/CAKE rows and invalid amount/permission; rolls back audit failure', async () => {
    const owner = await employee();
    const original = await db.incomeRecord.create({ data: { employeeId: owner.id, settlementMonth: month, source: 'manual', incomeUsd: '10', status: 'confirmed' } });
    const edit = { id: original.id, expectedUpdatedAt: original.updatedAt.toISOString() };
    await expect(finance.saveManualIncome('2026-08', owner.id, '20', { ...edit, expectedUpdatedAt: '2020-01-01' }, actor)).rejects.toThrow('已变化');
    await expect(finance.saveManualIncome('2026-07', owner.id, '20', edit, actor)).rejects.toThrow('不属于');
    await expect(finance.saveManualIncome('2026-08', (await employee()).id, '20', edit, actor)).rejects.toThrow('不属于');
    await expect(finance.saveManualIncome('2026-08', owner.id, '-1', edit, actor)).rejects.toThrow();
    await expect(finance.saveManualIncome('2026-08', 'unassigned', '20', edit, actor)).rejects.toThrow();
    await expect(finance.saveManualIncome('2026-08', owner.id, '20', edit, { ...actor, permissions: [] })).rejects.toThrow('权限');
    const spy = jest.spyOn(audit, 'success').mockRejectedValueOnce(new Error('audit-write-failure'));
    await expect(finance.saveManualIncome('2026-08', owner.id, '5', edit, actor)).rejects.toThrow('audit-write-failure'); spy.mockRestore();
    expect(await db.incomeRecord.findUnique({ where: { id: original.id } })).toEqual(original);
    expect(await db.incomeRecord.count({ where: { employeeId: owner.id } })).toBe(1);
    const orphan = await db.incomeRecord.create({ data: { employeeId: owner.id, settlementMonth: month, source: 'cake_adjustment', incomeUsd: '2', status: 'confirmed' } });
    await expect(finance.saveManualIncome('2026-08', owner.id, '20', { id: orphan.id, expectedUpdatedAt: orphan.updatedAt.toISOString() }, actor)).rejects.toThrow('不属于');
    expect((await finance.manualIncome('2026-08', owner.id, actor)).items.map(row => row.id)).toEqual([original.id]);
    expect(await db.incomeRecord.findUnique({ where: { id: orphan.id } })).toEqual(orphan);
  });

  it('confirms selected drafts and disables selected records atomically; retries are idempotent and monthly review follows real adjustments', async () => {
    const fixture = await drafts();
    expect(await cake.batch(fixture.body, 'confirm', actor)).toMatchObject({ processed: 2, reused: false });
    expect((await readCakeMonthlyReview(db, fixture.account.id, month)).status).toBe('adjusted');
    const auditCount = await db.auditLog.count();
    expect(await cake.batch(fixture.body, 'confirm', actor)).toMatchObject({ reused: true });
    expect(await db.auditLog.count()).toBe(auditCount);
    await expect(cake.batch({ ...fixture.body, items: fixture.body.items.slice(0, 1) }, 'confirm', actor)).rejects.toThrow('批次标识');
    const rows = await db.incomeRecord.findMany({ where: { id: { in: fixture.rows.map(r => r.id) } } });
    const disableBody = { ...fixture.body, requestId: randomUUID(), items: rows.map(r => ({ id: r.id, updatedAt: r.updatedAt.toISOString() })) };
    await cake.batch(disableBody, 'disable', actor);
    expect(await db.incomeRecord.count({ where: { id: { in: rows.map(r => r.id) }, status: 'disabled' } })).toBe(2);
    expect((await readCakeMonthlyReview(db, fixture.account.id, month)).status).toBe('unreviewed');
    expect(await cake.batch(disableBody, 'disable', actor)).toMatchObject({ reused: true });
  });

  it('rejects cross-account/month IDs and a changed native baseline without touching any selected draft', async () => {
    const fixture = await drafts(), foreign = await drafts();
    await expect(cake.batch({ ...fixture.body, items: [fixture.body.items[0], foreign.body.items[0]] }, 'confirm', actor)).rejects.toThrow('当前联盟账号及月份');
    await expect(cake.batch({ ...fixture.body, settlementMonth: '2026-07' }, 'confirm', actor)).rejects.toThrow('当前联盟账号及月份');
    await db.incomeRecord.updateMany({ where: { affiliateAccountId: fixture.account.id, source: 'cake', subValue: 'SUB-1' }, data: { incomeUsd: '201.2' } });
    await expect(cake.batch(fixture.body, 'confirm', actor)).rejects.toThrow('已变化');
    expect(await db.incomeRecord.count({ where: { id: { in: fixture.rows.map(r => r.id) }, status: 'draft' } })).toBe(2);
  });

  it('rejects changed versions, mixed invalid statuses and unauthorized batches; a second audit failure rolls every row back', async () => {
    const fixture = await drafts();
    await expect(cake.batch(fixture.body, 'confirm', { ...actor, roleCode: 'operations' })).rejects.toThrow('super_admin');
    await expect(cake.batch({ ...fixture.body, items: [{ ...fixture.body.items[0], updatedAt: '2020-01-01' }] }, 'confirm', actor)).rejects.toThrow('记录已变化');
    const originalAudit = audit.success.bind(audit);
    const auditBefore = await db.auditLog.count();
    const spy = jest.spyOn(audit, 'success').mockImplementationOnce(originalAudit).mockRejectedValueOnce(new Error('second-audit-failure'));
    await expect(cake.batch(fixture.body, 'confirm', actor)).rejects.toThrow('second-audit-failure'); spy.mockRestore();
    expect(await db.auditLog.count()).toBe(auditBefore);
    expect(await db.incomeRecord.count({ where: { id: { in: fixture.rows.map(r => r.id) }, status: 'draft' } })).toBe(2);
    const changed = await db.incomeRecord.update({ where: { id: fixture.rows[1].id }, data: { status: 'confirmed' } });
    await expect(cake.batch({ ...fixture.body, items: [fixture.body.items[0], { id: changed.id, updatedAt: changed.updatedAt.toISOString() }] }, 'confirm', actor)).rejects.toThrow('有效草稿');
    expect((await db.incomeRecord.findUniqueOrThrow({ where: { id: fixture.rows[0].id } })).status).toBe('draft');
  });

  it('serializes concurrent retries and conflicting edits without duplicate income or audits', async () => {
    const owner = await employee(), requestId = randomUUID();
    const added = await Promise.all([1, 2].map(() => finance.saveManualIncome('2026-08', owner.id, '12.34', { requestId, reason: 'Concurrent add' }, actor)));
    expect(added[0].id).toBe(added[1].id);
    expect(await db.incomeRecord.count({ where: { employeeId: owner.id } })).toBe(1);
    const original = await db.incomeRecord.findUniqueOrThrow({ where: { id: added[0].id } });
    const edits = await Promise.allSettled(['20', '30'].map(value => finance.saveManualIncome('2026-08', owner.id, value, { id: original.id, expectedUpdatedAt: original.updatedAt.toISOString() }, actor)));
    expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(edits.filter(result => result.status === 'rejected')).toHaveLength(1);
    const fixture = await drafts(), before = await db.auditLog.count();
    const batches = await Promise.all([1, 2].map(() => cake.batch(fixture.body, 'confirm', actor)));
    expect(batches.map(result => result.reused).sort()).toEqual([false, true]);
    expect(await db.auditLog.count()).toBe(before + 3);
    expect(await db.incomeRecord.count({ where: { id: { in: fixture.rows.map(r => r.id) }, status: 'confirmed' } })).toBe(2);
    const conflict = await drafts();
    const attempts = await Promise.allSettled(['confirm', 'disable'].map(operation => cake.batch({ ...conflict.body, requestId: randomUUID() }, operation as 'confirm' | 'disable', actor)));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    const states = await db.incomeRecord.findMany({ where: { id: { in: conflict.rows.map(r => r.id) } }, select: { status: true } });
    expect(new Set(states.map(row => row.status)).size).toBe(1);
  });

  it('blocks manual entry writes and batch confirmation/disable after month lock', async () => {
    const fixture = await drafts();
    await db.monthlySettlement.create({ data: { settlementMonth: month, status: 'locked' } });
    await expect(finance.saveManualIncome('2026-08', fixture.owner.id, '1', { requestId: randomUUID() }, actor)).rejects.toThrow('锁账');
    await expect(cake.batch(fixture.body, 'confirm', actor)).rejects.toThrow();
    await expect(cake.batch(fixture.body, 'disable', actor)).rejects.toThrow();
    expect(await db.incomeRecord.count({ where: { id: { in: fixture.rows.map(r => r.id) }, status: 'draft' } })).toBe(2);
  });
});
