require('./monthly-finance-live-runtime.cjs');
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const dir = path.resolve(__dirname, '../tmp/monthly-finance-live'), db = new PrismaClient();
const aliases = JSON.parse(fs.readFileSync(path.join(dir, 'source-aliases.private.json')));
const alias = id => aliases.find(a => a.id === id)?.code || id;
const month = '2026-08', origin = 'http://localhost:3061';
async function snapshot() {
  const tasks = await db.syncTask.findMany({ where: { refreshBatchId: { not: null } }, orderBy: { createdAt: 'asc' }, select: { id: true, provider: true, affiliateAccountId: true, status: true, attemptCount: true, lastErrorCategory: true, nextAttemptAt: true, resultPayload: true, createdAt: true, finishedAt: true } });
  const spend = await db.cardSpendEvent.groupBy({ by: ['provider', 'status'], where: { settlementMonth: new Date(month + '-01') }, _count: true, _sum: { spendUsd: true } });
  const income = await db.incomeRecord.groupBy({ by: ['affiliateAccountId', 'source', 'status'], where: { settlementMonth: new Date(month + '-01') }, _count: true, _sum: { incomeUsd: true } });
  const events = await db.cardSpendEvent.findMany({ where: { settlementMonth: new Date(month + '-01') }, orderBy: { id: 'asc' }, select: { id: true, spendUsd: true, employeeId: true, status: true } });
  const manuals = await db.manualCardSpendEntry.findMany({ where: { settlementMonth: new Date(month + '-01') } });
  const fees = await db.monthlyCardProviderFeeRate.findMany({ where: { settlementMonth: new Date(month + '-01') } });
  return { at: new Date().toISOString(), tasks: tasks.map(t => ({ source: alias(t.provider || t.affiliateAccountId), id: t.id, status: t.status, attempts: t.attemptCount, error: t.lastErrorCategory, nextAttemptAt: t.nextAttemptAt, coverage: t.resultPayload?.monthlyCoverage || null, started: t.createdAt, finished: t.finishedAt })), spend, income: income.map(i => ({ ...i, affiliateAccountId: alias(i.affiliateAccountId) })), eventHash: createHash('sha256').update(JSON.stringify(events)).digest('hex'), manualHash: createHash('sha256').update(JSON.stringify(manuals)).digest('hex'), feeHash: createHash('sha256').update(JSON.stringify(fees)).digest('hex') };
}
(async () => {
  const login = JSON.parse(fs.readFileSync(path.join(dir, 'login.json')));
  const auth = await (await fetch(origin + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(login) })).json();
  if (!auth.token) throw new Error('AUTH_FAILED');
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token };
  const mode = process.argv[2] || 'status';
  if (mode === 'refresh') {
    const before = await snapshot(); fs.writeFileSync(path.join(dir, 'before-refresh-' + Date.now() + '.json'), JSON.stringify(before, null, 2));
    const body = { settlementMonth: month }; if (process.argv[3]) body.source = aliases.find(a => a.code === process.argv[3])?.id || process.argv[3];
    const first = await fetch(origin + '/dashboard/monthly/refresh', { method: 'POST', headers, body: JSON.stringify(body) });
    const a = await first.json(); const second = await fetch(origin + '/dashboard/monthly/refresh', { method: 'POST', headers, body: JSON.stringify(body) }); const b = await second.json();
    const result = { at: new Date().toISOString(), firstStatus: first.status, repeatStatus: second.status, sameBatch: a.batchId === b.batchId && !!a.batchId, reused: b.reused, batchId: a.batchId || null };
    fs.appendFileSync(path.join(dir, 'http-refresh-evidence.jsonl'), JSON.stringify(result) + '\n'); console.log(JSON.stringify(result));
  }
  const result = await snapshot();
  const status = await fetch(origin + '/dashboard/monthly/status?settlementMonth=' + month, { headers });
  const s = await status.json(); result.httpStatus = status.status; result.refreshing = s.refreshing; result.coveredThrough = s.coveredThrough; result.requiredMonthEnd = s.requiredMonthEnd;
  fs.writeFileSync(path.join(dir, 'http-latest-evidence.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
})().catch(() => { console.error('HTTP_VALIDATION_FAILED_NO_SECRET_OUTPUT'); process.exitCode = 1; }).finally(() => db.$disconnect());
