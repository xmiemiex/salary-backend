import {
  CommonStatus,
  PrismaClient,
  Provider,
  SettlementStatus,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskStatus,
  SyncTaskType,
  SyncUnmatchedEventStatus,
} from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SyncReconciliationService } from '../sync-reconciliation/sync-reconciliation.service';
import { DashboardService } from './dashboard.service';

const databaseDescribe = process.env.TASK56_DATABASE_TESTS === '1' ? describe : describe.skip;

databaseDescribe('DashboardService PostgreSQL integration', () => {
  jest.setTimeout(180_000);
  const baseUrl = process.env.DATABASE_URL!;
  const schema = `task56_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  const month = new Date('2026-04-01T00:00:00.000Z');
  const emptyMonth = new Date('2025-01-01T00:00:00.000Z');
  const beforeGeneration = new Date('2026-04-10T00:00:00.000Z');
  const generatedAt = new Date('2026-04-15T00:00:00.000Z');
  const afterGeneration = new Date('2026-04-20T00:00:00.000Z');
  let admin: PrismaClient;
  let client: PrismaClient;
  let service: DashboardService;
  let settlementId: string;
  let staleIncomeId: string;

  beforeAll(async () => {
    if (!baseUrl) throw new Error('DATABASE_URL is required when TASK56_DATABASE_TESTS=1.');
    admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const command = process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm prisma migrate deploy'] }
      : { file: 'pnpm', args: ['prisma', 'migrate', 'deploy'] };
    execFileSync(command.file, command.args, { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' });
    client = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
    service = new DashboardService(client as never, new SyncReconciliationService(client as never));

    const [employeeA, employeeB, locker] = await Promise.all([
      client.employee.create({ data: { employeeCode: 'T56-A', name: 'Task56 A' } }),
      client.employee.create({ data: { employeeCode: 'T56-B', name: 'Task56 B' } }),
      client.adminUser.create({ data: { username: 'task56_locker', displayName: 'Task56 Locker', passwordHash: 'integration-only' } }),
    ]);
    const affiliate = await client.affiliateAccount.create({ data: { platform: 'everflow', accountCode: 'T56-EF' } });
    const incomeA = await client.incomeRecord.create({ data: { settlementMonth: month, affiliateAccountId: affiliate.id, employeeId: employeeA.id, source: 'everflow', externalRecordId: 't56-income-a', incomeUsd: '0.1', status: CommonStatus.confirmed, updatedAt: beforeGeneration } });
    staleIncomeId = incomeA.id;
    await client.incomeRecord.create({ data: { settlementMonth: month, affiliateAccountId: affiliate.id, employeeId: employeeB.id, source: 'everflow', externalRecordId: 't56-income-b', incomeUsd: '0.2', status: CommonStatus.confirmed, updatedAt: beforeGeneration } });
    await client.cardSpendEvent.createMany({ data: [
      { settlementMonth: month, provider: Provider.airwallex, cardId: 'T56-AW', employeeId: employeeA.id, externalEventId: 't56-spend-a', transactionAt: beforeGeneration, spendUsd: '0.03', status: CommonStatus.confirmed, updatedAt: beforeGeneration },
      { settlementMonth: month, provider: Provider.photonpay, cardId: 'T56-PP', employeeId: employeeB.id, externalEventId: 't56-spend-b', transactionAt: beforeGeneration, spendUsd: '0.07', status: CommonStatus.confirmed, updatedAt: beforeGeneration },
    ] });
    await client.manualCardSpendEntry.create({ data: { settlementMonth: month, providerName: 'manual', employeeId: employeeA.id, settledSpendUsd: '0.05', feeRate: '0', actualSpendUsd: '0.05', status: SettlementStatus.confirmed, createdBy: locker.id, updatedAt: beforeGeneration } });
    await client.monthlyExchangeRate.create({ data: { settlementMonth: month, usdToRmbRate: '7.1', createdBy: locker.id, updatedAt: beforeGeneration } });
    await client.monthlyCardProviderFeeRate.createMany({ data: [
      { settlementMonth: month, provider: Provider.airwallex, feeRate: '0.01', createdBy: locker.id, updatedAt: beforeGeneration },
      { settlementMonth: month, provider: Provider.photonpay, feeRate: '0.02', createdBy: locker.id, updatedAt: beforeGeneration },
    ] });
    const settlement = await client.monthlySettlement.create({ data: { settlementMonth: month, status: SettlementStatus.locked, generatedAt, generatedBy: locker.id, confirmedAt: generatedAt, confirmedBy: locker.id, lockedAt: generatedAt, lockedBy: locker.id, details: { create: [
      { employeeId: employeeA.id, settlementMonth: month, finalSalaryRmb: '123.45', snapshot: { source: 'snapshot-a' } },
      { employeeId: employeeB.id, settlementMonth: month, finalSalaryRmb: '0.10', snapshot: { source: 'snapshot-b' } },
    ] } } });
    settlementId = settlement.id;
    await client.syncTask.createMany({ data: [
      { sourceType: SyncTaskSourceType.affiliate_income, taskType: SyncTaskType.affiliate_income, platform: SyncTaskPlatform.everflow, affiliateAccountId: affiliate.id, settlementMonth: month, status: SyncTaskStatus.completed, finishedAt: generatedAt },
      { sourceType: SyncTaskSourceType.card_spend, taskType: SyncTaskType.airwallex_card, platform: SyncTaskPlatform.airwallex, provider: Provider.airwallex, settlementMonth: month, status: SyncTaskStatus.failed, finishedAt: generatedAt },
    ] });
    await client.syncUnmatchedEvent.createMany({ data: [
      { settlementMonth: month, sourceType: SyncTaskSourceType.affiliate_income, taskType: SyncTaskType.affiliate_income, platform: SyncTaskPlatform.everflow, thirdPartyEventId: 't56-unmatched-income', reasonCode: 'SUB_ID_NOT_MAPPED', status: SyncUnmatchedEventStatus.open },
      { settlementMonth: month, sourceType: SyncTaskSourceType.card_spend, taskType: SyncTaskType.airwallex_card, provider: Provider.airwallex, thirdPartyEventId: 't56-unmatched-card', reasonCode: 'CARD_NOT_MAPPED', status: SyncUnmatchedEventStatus.open },
      { settlementMonth: month, sourceType: SyncTaskSourceType.card_spend, taskType: SyncTaskType.photonpay_card, provider: Provider.photonpay, thirdPartyEventId: 't56-resolved-card', reasonCode: 'CARD_NOT_MAPPED', status: SyncUnmatchedEventStatus.resolved, resolvedAt: generatedAt },
    ] });
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  it('crops regions by permission and never exposes salary to low permission', async () => {
    const low = await service.overview('2026-04', { userId: 'low', roleCode: 'employee', permissions: ['salary.view_self'] });
    expect(low).not.toHaveProperty('sync');
    expect(low).not.toHaveProperty('reconciliation');
    expect(low).not.toHaveProperty('unmatched');
    expect(low).not.toHaveProperty('employeesAndSettlement');
    const syncOnly = await service.overview('2026-04', { userId: 'ops', roleCode: 'operations', permissions: ['income.import'] });
    expect(syncOnly).toHaveProperty('sync');
    expect(syncOnly).not.toHaveProperty('employeesAndSettlement');
  });

  it('matches existing reconciliation semantics with exact Decimal amounts', async () => {
    const result = await fullOverview();
    expect(result.reconciliation).toEqual({
      affiliateRevenueUsd: '0.3', apiCardSpendUsd: '0.1', manualCardSpendUsd: '0.05', rawGrossProfitUsd: '0.15',
      matchedRevenueUsd: '0.3', unmatchedRevenueUsd: '0', matchedSpendUsd: '0.1', unmatchedSpendUsd: '0',
    });
  });

  it('counts only open unmatched events by source and reason', async () => {
    const result = await fullOverview();
    expect(result.unmatched).toMatchObject({ totalCount: 2, affiliateIncomeCount: 1, cardSpendCount: 1, byReason: { CARD_NOT_MAPPED: 1, SUB_ID_NOT_MAPPED: 1 } });
  });

  it('reads formal salary only from settlement details and permits a locked month query', async () => {
    const result = await fullOverview();
    expect(result.monthStatus).toMatchObject({ isLocked: true, settlementStatus: SettlementStatus.locked });
    expect(result.employeesAndSettlement).toMatchObject({ settlementDetailCount: 2, totalSalaryRmb: '123.55', settlementStatus: SettlementStatus.locked });
  });

  it('is strictly read-only across business rows, states, timestamps, and audit logs', async () => {
    const before = await businessFingerprint();
    await fullOverview();
    await fullOverview();
    const after = await businessFingerprint();
    expect(after).toEqual(before);
  });

  it('marks outdated only after a real source updatedAt becomes later than generatedAt', async () => {
    let result = await fullOverview();
    expect(todoCodes(result)).not.toContain('SETTLEMENT_OUTDATED');
    await client.incomeRecord.update({ where: { id: staleIncomeId }, data: { updatedAt: afterGeneration } });
    result = await fullOverview();
    expect(todoCodes(result)).toContain('SETTLEMENT_OUTDATED');
  });

  it('returns complete zero-valued month sections instead of 500', async () => {
    const result = await service.overview('2025-01', fullActor());
    expect(result).toMatchObject({
      settlementMonth: '2025-01',
      sync: { taskCount: 0, pendingCount: 0, runningCount: 0, completedCount: 0, failedCount: 0, cancelledCount: 0 },
      reconciliation: { affiliateRevenueUsd: '0', apiCardSpendUsd: '0', manualCardSpendUsd: '0', rawGrossProfitUsd: '0' },
      unmatched: { totalCount: 0, affiliateIncomeCount: 0, cardSpendCount: 0 },
      monthStatus: { isLocked: false, settlementStatus: 'not_generated' },
      employeesAndSettlement: { employeesWithRevenueCount: 0, employeesWithSpendCount: 0, settlementDetailCount: 0, totalSalaryRmb: '0' },
    });
    expect(emptyMonth.toISOString().slice(0, 7)).toBe('2025-01');
  });

  async function fullOverview() { return service.overview('2026-04', fullActor()); }
  function fullActor() { return { userId: 'admin', roleCode: 'super_admin', permissions: ['salary.view_all', 'monthly_exchange_rate.manage', 'card_provider_fee_rate.manage'] }; }
  function todoCodes(result: Awaited<ReturnType<DashboardService['overview']>>) { return (result.todos as Array<{ code: string }>).map((todo) => todo.code); }
  async function businessFingerprint() {
    const [syncTasks, unmatched, settlement, audits] = await Promise.all([
      client.syncTask.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true, updatedAt: true } }),
      client.syncUnmatchedEvent.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true, updatedAt: true } }),
      client.monthlySettlement.findUniqueOrThrow({ where: { id: settlementId }, select: { id: true, status: true, updatedAt: true, lockedAt: true } }),
      client.auditLog.findMany({ orderBy: { id: 'asc' }, select: { id: true, createdAt: true, result: true } }),
    ]);
    return { syncTasks, unmatched, settlement, audits };
  }
});

function withSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}
