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
    const adapter = { execute: jest.fn(async (context: any) => context.provider === 'airwallex' ? { status: 'failed', successCount: 0, failedCount: 1, message: 'simulated timeout', errorMessage: 'simulated timeout', errorCategory: 'TIMEOUT', resultPayload: {} } : { status: 'completed', successCount: 0, failedCount: 0, message: 'simulated zero', errorMessage: null, resultPayload: {} }) };
    const credentials = { getAffiliateAccountCredentialPayload: async () => ({ credentialId: 'simulated', payload: {} }), getCardProviderCredentialPayload: async () => ({ credentialId: 'simulated', payload: {} }) };
    const executor = new SyncAutoExecutionService(db as never, new AuditService(db as never), { resolve: () => adapter } as never, credentials as never);
    for (let i = 0; i < 8; i++) await executor.pollDashboard(new Date(Date.now() + i * 3600000));
    const data = await service.read('2026-08');
    expect(data.sources.find(s => s.key === 'airwallex')?.status).toBe('failed');
    expect(data.sources.find(s => s.key === 'photonpay')?.status).toBe('completed');
    expect(data.totals).toMatchObject({ totalSpend: '4150', profit: '5850' });
    expect(data.complete).toBe(false);
    const retry = await service.refresh('2026-08', actor, 'airwallex');
    expect(await db.syncTask.count({ where: { refreshBatchId: retry.batchId! } })).toBe(1);
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
