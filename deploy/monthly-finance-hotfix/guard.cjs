// Read-only production guard. Writes only JSON evidence on stdout, never credentials or transaction identifiers.
const { PrismaClient } = require('@prisma/client');
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const db = new PrismaClient(), mode = process.argv[2] || 'before';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
(async () => {
  const migrationRoot = '/release-source/prisma/migrations';
  const expected = Object.fromEntries(fs.readdirSync(migrationRoot).filter(n => fs.existsSync(path.join(migrationRoot, n, 'migration.sql'))).map(n => [n, digest(fs.readFileSync(path.join(migrationRoot, n, 'migration.sql')))]));
  if (Object.keys(expected).length !== 27 || !expected['20260906010000_transaction_page_resume']) throw Error('CANDIDATE_MIGRATIONS_CHANGED');
  const result = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const migrations = await tx.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
    if (migrations.length !== 27 || migrations.some(m => !m.finished_at || m.rolled_back_at || expected[m.migration_name] !== m.checksum)) throw Error('MIGRATION_DRIFT');
    if (process.env.SYNC_PLANNER_ENABLED !== 'false' || process.env.SYNC_AUTO_EXECUTION_ENABLED !== 'false') throw Error('AUTOMATIC_FLAGS_CHANGED');
    const active = await tx.syncTask.count({ where: { status: { in: ['pending', 'running', 'retry_wait'] } } });
    if (mode === 'before' && active) throw Error('ACTIVE_SYNC');
    const locks = await tx.monthlySettlement.findMany({ orderBy: { id: 'asc' } });
    const income = await tx.incomeRecord.findMany({ orderBy: { id: 'asc' } });
    const manualIncome = income.filter(r => ['manual', 'manual_adjustment', 'cake_adjustment'].includes(r.source));
    const manual = await tx.manualCardSpendEntry.findMany({ orderBy: { id: 'asc' } });
    const fees = await tx.monthlyCardProviderFeeRate.findMany({ orderBy: { id: 'asc' } });
    const adposFees = await tx.monthlyAdposFeeRate.findMany({ orderBy: { settlementMonth: 'asc' } });
    const mappings = await tx.subIdMapping.findMany({ orderBy: { id: 'asc' } });
    const employees = await tx.employee.findMany({ select: { id: true, businessSubId: true }, orderBy: { id: 'asc' } });
    const aliases = await tx.providerEmailAlias.findMany({ orderBy: { id: 'asc' } });
    const exclusions = await tx.providerCardAccountingExclusion.findMany({ orderBy: { id: 'asc' } });
    const latest = await tx.syncTask.findFirst({ where: { provider: 'photonpay', settlementMonth: new Date('2026-07-01'), OR: [{ requestPayload: { equals: { settlementMonth: '2026-07' } } }, { requestPayload: { equals: {} } }] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const scans = await tx.$queryRaw`SELECT state->>'windowIndex' AS "windowIndex", state->>'nextPage' AS "nextPage", state->>'successCount' AS "successCount" FROM provider_transaction_scans WHERE provider='photonpay' AND settlement_month='2026-07-01'::date`;
    return {
      at: new Date().toISOString(), migrations: migrations.map(m => m.migration_name), flagsFalse: true, activeSync: active,
      julyLocked: locks.some(r => r.settlementMonth.toISOString().slice(0, 10) === '2026-07-01' && r.status === 'locked'),
      preservation: { allIncome: hash(income), manualIncome: hash(manualIncome), manualCost: hash(manual), providerFees: hash(fees), adposFees: hash(adposFees), mappings: hash(mappings), employeeSubIds: hash(employees), locks: hash(locks), providerEmailAliases: hash(aliases), providerCardExclusions: hash(exclusions) },
      photonpay: latest ? { status: latest.status, attemptCount: latest.attemptCount, successCount: latest.successCount, failedCount: latest.failedCount, errorCategory: latest.lastErrorCategory, nextAttemptAt: latest.nextAttemptAt, monthlyCoverage: latest.resultPayload?.monthlyCoverage ?? null, resumedFromPage: latest.resultPayload?.resumedFromPage ?? null, resumedFromWindow: latest.resultPayload?.resumedFromWindow ?? null, providerCode: latest.resultPayload?.providerError?.providerCode ?? null } : null,
      pageCheckpoint: scans,
    };
  }, { timeout: 60000 });
  console.log(JSON.stringify(result));
})().catch(e => { console.error(/^[A-Z_]+$/.test(e.message) ? e.message : 'SAFE_GUARD_FAILED'); process.exitCode = 1; }).finally(() => db.$disconnect());
