import { ProviderCardInventoryService } from '../card-bindings/provider-card-inventory.service';
import { ProviderRequestError } from '../sync-tasks/provider-request-error';
import { monthlyCoverage } from '../sync-tasks/monthly-coverage';
import { PrismaClient, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { MonthlyFinanceService, financeAmounts } from './monthly-finance.service';
import { applyAdposMonthlyCost } from '../settlement/adpos-monthly-cost';
import { AuditService } from '../audit/audit.service';
import { SyncAutoExecutionService } from '../sync-tasks/sync-auto-execution.service';

const integration = process.env.MONTHLY_FINANCE_DATABASE_TESTS === '1' ? describe : describe.skip;
integration('monthly finance real PostgreSQL (provider adapters explicitly simulated)', () => {
  jest.setTimeout(180000);
  const schema = `finance_${randomUUID().replace(/-/g, '')}`;
  const month = new Date('2026-08-01T00:00:00Z');
  let admin: PrismaClient, db: PrismaClient, service: MonthlyFinanceService;
  let employee: string, actor: { userId: string; roleCode: string; permissions: string[] };
  beforeAll(async () => {
    admin = new PrismaClient();
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('schema', schema);
    execFileSync(process.execPath, [path.resolve(__dirname, '../../../../node_modules/prisma/build/index.js'), 'migrate', 'deploy'], { cwd: path.resolve(__dirname, '../../../..'), env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe' });
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const user = await db.adminUser.create({ data: { username: 'finance-integration', displayName: 'Integration', passwordHash: 'not-a-login' } });
    actor = { userId: user.id, roleCode: 'super_admin', permissions: ['salary.view_all', 'income.import', 'manual_card_spend.manage'] };
    employee = (await db.employee.create({ data: { employeeCode: 'fixture', name: 'Fixture', businessSubId: 'SUB-001' } })).id;
    service = new MonthlyFinanceService(db as never, new AuditService(db as never));
    for (const [index, amount] of ['2000','3000','5000'].entries()) {
      const a = await db.affiliateAccount.create({ data: { platform: index === 2 ? 'cake' : 'everflow', accountCode: `alliance-${index}`, accountName: ['Blitz','Alliance B','Alliance C'][index] } });
      await db.subIdMapping.create({ data: { affiliateAccountId: a.id, employeeId: employee, subField: 'sub1', subValue: `raw-${index}`, effectiveMonth: month } });
      await db.incomeRecord.create({ data: { settlementMonth: month, employeeId: employee, affiliateAccountId: a.id, source: a.platform, incomeUsd: amount, subValue: `raw-${index}`, status: 'confirmed' } });
      await db.affiliateAccountCredential.create({ data: { affiliateAccountId: a.id, encryptedPayload: 'SIMULATED-ADAPTER-ONLY' } });
    }
    for (const [provider, amount] of [['airwallex','1000'],['photonpay','2000']] as const) {
      await db.cardSpendEvent.create({ data: { settlementMonth: month, employeeId: employee, provider, cardId: `fixture-${provider}`, externalEventId: `fixture-${provider}`, transactionAt: new Date('2026-08-31T15:59:59Z'), settledAt: new Date('2026-09-01T00:00:00Z'), amount: '12345', currency: 'JPY', spendUsd: amount, status: 'confirmed' } });
      await db.cardProviderCredential.create({ data: { provider, encryptedPayload: 'SIMULATED-ADAPTER-ONLY' } });
    }
    await db.cardSpendEvent.create({ data: { settlementMonth: month, employeeId: employee, provider: 'photonpay', cardId: 'pending-fixture', transactionAt: month, spendUsd: '99999', status: 'draft' } });
  });
  afterAll(async () => { await db?.$disconnect(); if (admin) { await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.$disconnect(); } });
  it('unifies cross-alliance SUB IDs; excludes pending and retains actual USD settled principal', async () => {
    const data = await service.read('2026-08');
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ subId: 'SUB-001', attributionPending: false, totalIncome: '10000', spends: { airwallex: '1000', photonpay: '2000' }, totalSpend: null, profit: null });
    expect(data.sources.every(s => s.status === 'missing')).toBe(true);
  });
  it('saves Adpos without a fee; missing fees block final salary; 0% is explicit and month-scoped', async () => {
    await service.saveAdpos('2026-08', 'SUB-001', '1000', actor);
    const entries = await db.manualCardSpendEntry.findMany();
    await expect(applyAdposMonthlyCost(db as never, month, entries)).rejects.toThrow('手续费');
    await service.saveFees('2026-07', { airwallex: '0', photonpay: '0', adpos: '0' }, actor);
    expect((await service.read('2026-08')).rates.adpos).toBeNull();
    await service.saveFees('2026-08', { airwallex: '0.03', photonpay: '0.05', adpos: '0.02' }, actor);
    const data = await service.read('2026-08');
    expect(data.totals).toMatchObject({ rawSpend: '4000', totalSpend: '4150', profit: '5850', margin: '140.96' });
    expect((await applyAdposMonthlyCost(db as never, month, await db.manualCardSpendEntry.findMany({ where: { settlementMonth: month } })))[0].actualSpendUsd.toString()).toBe('1020');
    await expect(service.saveFees('2026-08', { airwallex: '', photonpay: '0', adpos: '0' }, actor)).rejects.toThrow();
  });
  it('does not treat an unassigned raw SUB ID as resolved ownership', async () => {
    const orphan = await db.incomeRecord.create({ data: { settlementMonth: month, source: 'manual', subValue: 'orphan-sub', incomeUsd: '10', status: 'confirmed' } });
    const data = await service.read('2026-08');
    expect(data.rows.find(row => row.key === 'unassigned')?.attributionPending).toBe(true);
    expect(data.complete).toBe(false);
    await db.incomeRecord.update({ where: { id: orphan.id }, data: { status: 'draft' } });
  });
  it('preserves manual income adjustments, edits aggregate Adpos without duplication', async () => {
    const adjustment = await db.incomeRecord.create({ data: { settlementMonth: month, employeeId: employee, source: 'manual_adjustment', incomeUsd: '-100', status: 'confirmed' } });
    expect((await service.read('2026-08')).totals.totalIncome).toBe('9900');
    await db.incomeRecord.update({ where: { id: adjustment.id }, data: { status: 'draft' } });
    await service.saveAdpos('2026-08', 'SUB-001', '1100', actor);
    await service.saveAdpos('2026-08', 'SUB-001', '1000', actor);
    expect(await db.manualCardSpendEntry.count()).toBe(1);
  });
  it('persists a single batch under concurrent clicks, recovers state, isolates timeout and retries only failed source', async () => {
    const [a,b] = await Promise.all([service.refresh('2026-08', actor), service.refresh('2026-08', actor)]);
    expect(a.batchId).toBe(b.batchId);
    expect(await db.syncTask.count({ where: { refreshBatchId: a.batchId! } })).toBe(5);
    expect((await service.read('2026-08')).refreshing).toBe(true);
    const adapter = { execute: jest.fn(async (context: any) => context.provider === 'airwallex' ? { status: 'failed', successCount: 0, failedCount: 1, message: 'simulated timeout', errorMessage: 'simulated timeout', errorCategory: 'TIMEOUT', resultPayload: {} } : { status: 'completed', successCount: 0, failedCount: 0, message: 'simulated zero', errorMessage: null, resultPayload: { monthlyCoverage: monthlyCoverage(context, 'completed', 0) } }) };
    const credentials = { getAffiliateAccountCredentialPayload: async () => ({ credentialId: 'simulated', payload: {} }), getCardProviderCredentialPayload: async () => ({ credentialId: 'simulated', payload: {} }) };
    const executor = new SyncAutoExecutionService(db as never, new AuditService(db as never), { resolve: () => adapter } as never, credentials as never);
    for (let i = 0; i < 8; i++) { await executor.pollDashboard(new Date(Date.now() + i * 3600000)); await executor.drainDashboard(); }
    const data = await service.read('2026-08');
    expect(data.sources.find(s => s.key === 'airwallex')?.status).toBe('failed');
    expect(data.sources.find(s => s.key === 'photonpay')?.status).toBe('completed');
    expect(data.totals).toMatchObject({ totalSpend: '4150', profit: '5850' });
    expect(data.complete).toBe(false);
    const retry = await service.refresh('2026-08', actor, 'airwallex');
    expect(await db.syncTask.count({ where: { refreshBatchId: retry.batchId! } })).toBe(1);
  });
  it('requires posted full-month proof; later preview, calibration, short windows and 60-card subsets cannot replace it', async () => {
    const batch = await service.refresh('2026-07', actor);
    const tasks = await db.syncTask.findMany({ where: { refreshBatchId: batch.batchId! } });
    for (const task of tasks) await db.syncTask.update({ where: { id: task.id }, data: { status: 'completed', failedCount: 0, finishedAt: new Date('2026-08-01T00:00:00Z'), requestPayload: { historicalBackfill: { from: '2026-07-01', to: '2026-07-08', previewOnly: true } } } });
    expect((await service.read('2026-07')).complete).toBe(false);
    for (const task of tasks) await db.syncTask.update({ where: { id: task.id }, data: { requestPayload: { settlementMonth: '2026-07' }, resultPayload: { monthlyCoverage: monthlyCoverage({ settlementMonth: new Date('2026-07-01'), coverageStartedAt: new Date('2026-08-01') } as any, 'completed', 0) } } });
    const before = await service.read('2026-07');
    expect(before.complete).toBe(true);
    expect(before.coveredThrough?.toISOString()).toBe('2026-07-31T16:00:00.000Z');
    for (const payload of [{ previewOnly: true }, { calibration: true }, { from: '2026-07-01', to: '2026-07-08' }, { historicalBackfill: { previewOnly: false }, targetCardIds: Array(60).fill('simulated') }]) {
      for (const task of tasks) await db.syncTask.create({ data: { settlementMonth: task.settlementMonth, sourceType: task.sourceType, taskType: task.taskType, platform: task.platform, provider: task.provider, affiliateAccountId: task.affiliateAccountId, status: 'completed', failedCount: 0, requestPayload: payload, finishedAt: new Date() } });
    }
    const after = await service.read('2026-07');
    expect(after.complete).toBe(true);
    expect(after.sources.map(s => s.lastSuccessAt)).toEqual(before.sources.map(s => s.lastSuccessAt));
    expect(after.coveredThrough).toEqual(before.coveredThrough);
    expect(after.queriedAt.getTime()).toBeGreaterThan(after.coveredThrough!.getTime());
  });

  it('refills the free slot while slow A still runs and isolates identical sources across batches', async () => {
    await db.syncTask.updateMany({ where: { status: { in: ['pending', 'retry_wait'] } }, data: { status: 'cancelled' } });
    const batch = await service.refresh('2026-06', actor);
    const tasks = await db.syncTask.findMany({ where: { refreshBatchId: batch.batchId! }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    let releaseA!: () => void;
    const slow = new Promise<void>(resolve => { releaseA = resolve; });
    const started: string[] = [];
    const adapter = { execute: async (context: any) => { started.push(context.taskId); if (context.taskId === tasks[0].id) await slow; return { status: 'completed', successCount: 0, failedCount: 0, message: 'simulated', resultPayload: { monthlyCoverage: monthlyCoverage(context, 'completed', 0) } }; } };
    const credentials = { getAffiliateAccountCredentialPayload: async () => ({ payload: {} }), getCardProviderCredentialPayload: async () => ({ payload: {} }) };
    const executor = new SyncAutoExecutionService(db as never, new AuditService(db as never), { resolve: () => adapter } as never, credentials as never);
    const waitFor = async (predicate: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out waiting for execution'); };
    try {
      expect((await executor.pollDashboard()).claimedCount).toBe(2);
      await waitFor(async () => (await db.syncTask.findUnique({ where: { id: tasks[1].id } }))?.status === 'completed');
      expect((await db.syncTask.findUnique({ where: { id: tasks[0].id } }))?.status).toBe('running');
      expect((await executor.pollDashboard()).claimedCount).toBe(1);
      await waitFor(async () => started.includes(tasks[2].id));
      expect(await db.syncTask.count({ where: { status: 'running' } })).toBeLessThanOrEqual(2);
      const copy = tasks[0];
      const duplicate = await db.syncTask.create({ data: { settlementMonth: copy.settlementMonth, refreshBatchId: copy.refreshBatchId, planningKey: `duplicate:${randomUUID()}`, sourceType: copy.sourceType, taskType: copy.taskType, platform: copy.platform, affiliateAccountId: copy.affiliateAccountId, provider: copy.provider, status: 'pending', triggerType: 'manual' } });
      await executor.pollDashboard();
      expect((await db.syncTask.findUnique({ where: { id: duplicate.id } }))?.status).toBe('pending');
    } finally { releaseA(); await executor.drainDashboard(); }
    for (let i = 0; i < 4; i++) { await executor.pollDashboard(); await executor.drainDashboard(); }
  });

  it('closes a dead final lease and permits a new dashboard retry; recovers a non-final expired lease', async () => {
    const batch = await service.refresh('2026-05', actor, 'airwallex');
    await db.monthlyRefreshBatch.update({ where: { id: batch.batchId! }, data: { createdAt: new Date(Date.now() - 60000) } });
    const task = (await db.syncTask.findFirst({ where: { refreshBatchId: batch.batchId! } }))!;
    await db.syncTask.update({ where: { id: task.id }, data: { status: 'running', attemptCount: 3, leaseOwner: 'dead-process', leaseExpiresAt: new Date(Date.now() - 1000) } });
    const execute = jest.fn(async () => ({ status: 'completed', failedCount: 0, successCount: 0, message: 'simulated', resultPayload: {} }));
    const executor = new SyncAutoExecutionService(db as never, new AuditService(db as never), { resolve: () => ({ execute }) } as never, { getCardProviderCredentialPayload: async () => ({ payload: {} }) } as never);
    await executor.pollDashboard();
    expect((await db.syncTask.findUnique({ where: { id: task.id } }))?.status).toBe('failed');
    expect((await service.status('2026-05')).refreshing).toBe(false);
    const retry = await service.refresh('2026-05', actor, 'airwallex');
    expect(retry.batchId).not.toBe(batch.batchId);
    const next = (await db.syncTask.findFirst({ where: { refreshBatchId: retry.batchId! } }))!;
    await db.syncTask.update({ where: { id: next.id }, data: { status: 'running', attemptCount: 1, leaseOwner: 'dead-process', leaseExpiresAt: new Date(Date.now() - 1000) } });
    await executor.pollDashboard(); await executor.drainDashboard();
    expect((await db.syncTask.findUnique({ where: { id: next.id } }))?.attemptCount).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('resumes AW persisted card and holder pages across new service instances without certifying partial scans', async () => {
    let failCards = true, failHolders = true;
    const calls: { from?: Date; page: number }[] = [];
    const aw = {
      listCards: async (request: any) => {
        calls.push(request);
        if (!request.from) return { cards: [], hasMore: false };
        if (request.from.toISOString() === '2018-01-01T00:00:00.000Z') {
          if (request.page === 1 && failCards) throw new ProviderRequestError('TIMEOUT', 'simulated interruption');
          return { cards: [{ card_id: `card-${request.page}`, cardholder_id: 'holder-1', card_number: '1234567890123456' }], hasMore: request.page === 0 };
        }
        return { cards: [], hasMore: false };
      },
      listCardholders: async ({ page }: any) => {
        if (page === 1 && failHolders) throw new ProviderRequestError('TIMEOUT', 'simulated holder interruption');
        return { cardholders: [{ cardholder_id: 'holder-1', email: 'fixture@example.test' }], hasMore: page === 0 };
      },
    };
    const make = () => new ProviderCardInventoryService(db as never, {} as never, aw as never, {} as never, new AuditService(db as never));
    const credential = { clientId: 'simulated', apiKey: 'simulated' };
    await expect(make().syncProviderWithPayload('airwallex', credential)).rejects.toThrow('interruption');
    expect(await db.providerInventoryCheckpoint.count()).toBe(0);
    const saved = (await db.providerInventoryScan.findUnique({ where: { provider: 'airwallex' } }))!;
    expect((saved.state as any).page).toBe(1);
    expect(JSON.stringify(saved.state)).not.toContain('1234567890123456');
    failCards = false; calls.length = 0;
    expect((await make().syncProviderWithPayload('airwallex', credential)).status).toBe('partial');
    expect(calls.filter(c => c.from)[0].page).toBe(1);
    expect(await db.providerInventoryCheckpoint.count()).toBe(0);
    failHolders = false; calls.length = 0;
    expect((await make().syncProviderWithPayload('airwallex', credential)).status).toBe('completed');
    expect(calls.filter(c => c.from)).toHaveLength(0);
    expect(await db.providerCard.count({ where: { provider: 'airwallex' } })).toBe(2);
    expect(await db.providerInventoryScan.count()).toBe(0);
    expect((await db.providerInventoryCheckpoint.findUnique({ where: { provider: 'airwallex' } }))?.completedThrough).toEqual(saved.through);
  });

  it('keeps summary and on-demand payloads bounded with 100 employees and 50,000 ledger events', async () => {
    const perfMonth = new Date('2026-04-01T00:00:00Z');
    await db.employee.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ id: randomUUID(), employeeCode: `perf-${i}`, name: 'Scale fixture', businessSubId: `PERF-${i}` })) });
    const employees = await db.employee.findMany({ where: { employeeCode: { startsWith: 'perf-' } } });
    const accounts = await db.affiliateAccount.findMany();
    await db.incomeRecord.createMany({ data: employees.flatMap(e => accounts.map(a => ({ employeeId: e.id, affiliateAccountId: a.id, settlementMonth: perfMonth, source: 'performance-fixture', incomeUsd: '1000', status: 'confirmed' as const }))) });
    await db.$executeRaw`
      INSERT INTO card_spend_events (id, settlement_month, employee_id, provider, card_id, external_event_id, transaction_at, spend_usd, status, updated_at)
      SELECT gen_random_uuid(), ${perfMonth}, e.id, CASE WHEN n % 2 = 0 THEN 'airwallex'::"Provider" ELSE 'photonpay'::"Provider" END,
        'scale-fixture', e.id::text || '-' || n, ${perfMonth}, 1, 'confirmed', now()
      FROM employees e CROSS JOIN generate_series(1,500) n WHERE e.employee_code LIKE 'perf-%'`;
    const elapsed: number[] = []; let bytes = 0;
    for (let i = 0; i < 5; i++) { const start = performance.now(); const result = await service.read('2026-04'); elapsed.push(performance.now() - start); bytes = Buffer.byteLength(JSON.stringify(result)); expect(result.rows).toHaveLength(100); expect(result.totals.rawSpend).toBe('50000'); }
    const details = await service.details('2026-04', employees[0].id, '2', 'airwallex');
    expect(details.items).toHaveLength(20); expect(details.total).toBe(250);
    const statusBytes = Buffer.byteLength(JSON.stringify(await service.status('2026-04')));
    console.log('MONTHLY_SCALE_EVIDENCE', JSON.stringify({ employees: 100, incomeRecords: 300, spendEvents: 50000, queryMs: elapsed.map(n => Math.round(n)), summaryBytes: bytes, statusBytes, detailBytes: Buffer.byteLength(JSON.stringify(details)) }));
    expect(Math.max(...elapsed)).toBeLessThan(5000); expect(bytes).toBeLessThan(250000); expect(statusBytes).toBeLessThan(10000);
  });

  it.each(['2026-08', '2025-12'])('expires the %s mid-month snapshot at GMT+8 month end, keeps failed refresh data, and accepts a genuine month-end refill', async (selectedMonth) => {
    const selected = new Date(`${selectedMonth}-01T00:00:00Z`);
    const midpoint = new Date(`${selectedMonth}-15T00:00:00Z`);
    const end = new Date(Date.UTC(selected.getUTCFullYear(), selected.getUTCMonth() + 1, 1) - 8 * 3600000);
    const afterEnd = new Date(end.getTime() + 86400000);
    // Existing August fixture is retained; use its confirmed amounts as the invariant.
    await service.saveFees(selectedMonth, { airwallex: '0.03', photonpay: '0.05', adpos: '0.02' }, actor);
    if (selectedMonth === '2025-12') await db.incomeRecord.create({ data: { settlementMonth: selected, employeeId: employee, source: 'snapshot-fixture', incomeUsd: '200', status: 'confirmed' } });
    // Isolate task chronology from earlier cases in this disposable schema; ledger rows remain unchanged.
    await db.syncTask.updateMany({ where: { settlementMonth: selected }, data: { status: 'cancelled' } });
    const batch = await service.refresh(selectedMonth, actor);
    const tasks = await db.syncTask.findMany({ where: { refreshBatchId: batch.batchId! } });
    const context = { settlementMonth: selected, coverageStartedAt: midpoint } as any;
    const proof = monthlyCoverage(context, 'completed', 0)!;
    const order = Date.now() + 10000;
    for (const task of tasks) await db.syncTask.update({ where: { id: task.id }, data: { status: 'completed', failedCount: 0, createdAt: new Date(order), finishedAt: midpoint, resultPayload: { monthlyCoverage: proof } } });
    const current = await service.read(selectedMonth, midpoint);
    expect(current.complete).toBe(true);
    expect(current.coverageScope).toBe('month_to_date');
    expect(current.coveredThrough).toEqual(midpoint);
    expect((await service.read(selectedMonth, new Date(end.getTime() - 1))).complete).toBe(true);
    const historical = await service.read(selectedMonth, end);
    expect(historical.complete).toBe(false);
    expect(historical.coverageScope).toBe('full_month');
    expect(historical.sources.every(source => source.status === 'partial' && source.reason?.includes('月末'))).toBe(true);
    expect(historical.coveredThrough).toEqual(midpoint);
    expect(historical.totals).toEqual(current.totals);
    for (const task of tasks) await db.syncTask.create({ data: { settlementMonth: selected, sourceType: task.sourceType, taskType: task.taskType, platform: task.platform, provider: task.provider, affiliateAccountId: task.affiliateAccountId, status: 'failed', failedCount: 1, lastErrorCategory: 'TIMEOUT', createdAt: new Date(order + 1000), finishedAt: afterEnd, requestPayload: { settlementMonth: selectedMonth } } });
    const failed = await service.read(selectedMonth, afterEnd);
    expect(failed.complete).toBe(false);
    expect(failed.sources.every(source => source.status === 'failed')).toBe(true);
    expect(failed.coveredThrough).toEqual(midpoint);
    expect(failed.totals).toEqual(current.totals);
    // A normal dashboard request can schedule the missing tail; no ledger reset is used.
    await db.monthlyRefreshBatch.update({ where: { id: batch.batchId! }, data: { createdAt: new Date(Date.now() - 60000) } });
    const refill = await service.refresh(selectedMonth, actor);
    expect(refill.batchId).not.toBe(batch.batchId);
    const refillTasks = await db.syncTask.findMany({ where: { refreshBatchId: refill.batchId! } });
    for (const task of refillTasks) await db.syncTask.update({ where: { id: task.id }, data: { status: 'completed', failedCount: 0, createdAt: new Date(order + 2000), finishedAt: afterEnd, resultPayload: { monthlyCoverage: monthlyCoverage({ ...context, coverageStartedAt: new Date(end.getTime() - 1) }, 'completed', 0) } } });
    expect((await service.read(selectedMonth, afterEnd)).complete).toBe(false);
    for (const task of refillTasks) await db.syncTask.update({ where: { id: task.id }, data: { resultPayload: { monthlyCoverage: monthlyCoverage({ ...context, coverageStartedAt: end }, 'completed', 0) } } });
    const complete = await service.read(selectedMonth, afterEnd);
    expect(complete.complete).toBe(true);
    expect(complete.coveredThrough).toEqual(end);
    expect(complete.totals).toEqual(current.totals);
  });

  it('summarizes current-task unmatched reasons and keeps retry state with real PostgreSQL', async () => {
    const selected = new Date('2026-03-01');
    const account = (await db.affiliateAccount.findFirst())!;
    const batch = await service.refresh('2026-03', actor, account.id);
    const task = (await db.syncTask.findFirst({ where: { refreshBatchId: batch.batchId } }))!;
    await db.syncTask.update({ where: { id: task.id }, data: { status: 'completed', successCount: 0, failedCount: 1 } });
    await db.syncUnmatchedEvent.create({ data: { settlementMonth: selected, sourceType: 'affiliate_income', taskType: 'affiliate_income', affiliateAccountId: account.id, syncTaskId: task.id, reasonCode: 'SUB_ID_NOT_MAPPED' } });
    // An unrelated old unresolved event must not inflate this task's reason count.
    await db.syncUnmatchedEvent.create({ data: { settlementMonth: selected, sourceType: 'affiliate_income', taskType: 'affiliate_income', affiliateAccountId: account.id, reasonCode: 'SUB_ID_MISSING' } });
    let source = (await service.status('2026-03')).sources.find(s => s.key === account.id)!;
    expect(source).toMatchObject({ status: 'failed', statusLabel: '未入账', unmatchedCount: 1, coverageComplete: false });
    expect(source.reason).toBe('1 条 SUB 未映射；成功 0 条 / 失败 1 条');
    await db.syncTask.update({ where: { id: task.id }, data: { status: 'retry_wait', successCount: 4, lastErrorCategory: 'RATE_LIMITED' } });
    source = (await service.status('2026-03')).sources.find(s => s.key === account.id)!;
    expect(source.status).toBe('retry_wait');
    expect(source.reason).toContain('供应商限流，等待自动重试');
    await db.syncTask.update({ where: { id: task.id }, data: { status: 'failed' } });
  });

  it('locked month rejects fees, Adpos and refresh including legacy direct writes', async () => {
    await db.monthlySettlement.create({ data: { settlementMonth: month, status: 'locked' } });
    await expect(service.saveFees('2026-08', { airwallex: '0', photonpay: '0', adpos: '0' }, actor)).rejects.toThrow('锁账');
    await expect(service.saveAdpos('2026-08', 'SUB-001', '50', actor)).rejects.toThrow('锁账');
    await expect(service.refresh('2026-08', actor)).rejects.toThrow('锁账');
    await expect(db.monthlyAdposFeeRate.update({ where: { settlementMonth: month }, data: { feeRate: '0' } })).rejects.toThrow('MONTH_LOCKED');
    expect((await service.read('2026-07')).rates.adpos).toBe('0');
  });
});

describe('finance Decimal arithmetic', () => {
  it('recomputes cost-denominator margin and distinguishes missing from zero', () => {
    expect(financeAmounts('10000', { airwallex: '1000', photonpay: '2000', adpos: '1000' }, { airwallex: '0.03', photonpay: '0.05', adpos: '0.02' })).toMatchObject({ rawSpend: '4000', totalSpend: '4150', profit: '5850', margin: '140.96' });
    expect(financeAmounts('0.3', { adpos: '0.1' }, { adpos: '0' }).profit).toBe('0.2');
    expect(financeAmounts('0', { adpos: '0' }, { adpos: null }).margin).toBeNull();
    expect(financeAmounts('1', { adpos: '1' }, { adpos: null }).profit).toBeNull();
  });
});
