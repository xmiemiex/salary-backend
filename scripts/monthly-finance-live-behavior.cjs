require('./monthly-finance-live-runtime.cjs');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const { PrismaClient, Prisma } = require('@prisma/client');
const dir = path.resolve(__dirname, '../tmp/monthly-finance-live'), db = new PrismaClient(), month = '2026-08';
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
(async () => {
 const auth = await (await fetch('http://localhost:3061/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: fs.readFileSync(path.join(dir, 'login.json'), 'utf8') })).json(); assert.ok(auth.token);
 const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token };
 const post = (route, body) => fetch('http://localhost:3061/dashboard/monthly/' + route, { method: 'POST', headers, body: JSON.stringify(body) });
 const mode = process.argv[2] || 'verify';
 if (mode === 'setup') {
   assert.equal(await db.manualCardSpendEntry.count(), 0, 'Do not overwrite existing manual data');
   assert.equal(await db.monthlyCardProviderFeeRate.count(), 0, 'Do not overwrite imported fee rates');
   assert.equal(await db.monthlyAdposFeeRate.count(), 0, 'Do not overwrite imported Adpos rates');
   const employee = await db.employee.findFirstOrThrow({ where: { subIdMappings: { some: {} } }, orderBy: { employeeCode: 'asc' } });
   assert.ok((await post('sub-id', { settlementMonth: month, rowKey: employee.id, subId: 'LIVE-VALIDATION-001' })).ok);
   assert.ok((await post('fees', { settlementMonth: month, rates: { airwallex: '0.03', photonpay: '0.03', adpos: '0.035' } })).ok);
   assert.ok((await post('adpos', { settlementMonth: month, subId: 'LIVE-VALIDATION-001', amount: '100' })).ok);
   const fixture = { employeeId: employee.id, synthetic: true, subId: 'LIVE-VALIDATION-001', month, originalBusinessSubId: employee.businessSubId };
   fs.writeFileSync(path.join(dir, 'behavior-fixture.private.json'), JSON.stringify(fixture));
 }
 const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'behavior-fixture.private.json')));
 const response = await fetch('http://localhost:3061/dashboard/monthly?settlementMonth=' + month, { headers }); assert.equal(response.status, 200); const data = await response.json();
 const row = data.rows.find(r => r.key === fixture.employeeId); assert.ok(row); assert.equal(row.subId, fixture.subId); assert.equal(data.rows.filter(r => r.key === fixture.employeeId).length, 1);
 const spend = await db.cardSpendEvent.groupBy({ by: ['provider'], where: { employeeId: fixture.employeeId, settlementMonth: new Date(month + '-01'), status: 'confirmed' }, _sum: { spendUsd: true } });
 for (const s of spend) assert.equal(row.spends[s.provider], s._sum.spendUsd.toString());
 assert.equal(row.spends.adpos, '100');
 const rateRows = await db.monthlyCardProviderFeeRate.findMany({ orderBy: { provider: 'asc' } }); const manualRows = await db.manualCardSpendEntry.findMany({ orderBy: { id: 'asc' } });
 const result = { at: new Date().toISOString(), syntheticFixture: true, realProviderLedger: true, unifiedEmployeeRows: 1, cardSpendMatchesEmployeeAggregate: true, preservedAdposUsd: row.spends.adpos, feeHash: hash(rateRows), manualHash: hash(manualRows), roi: row.margin };
 if (mode === 'setup') fs.writeFileSync(path.join(dir, 'behavior-baseline.json'), JSON.stringify(result, null, 2));
 else { const baseline = JSON.parse(fs.readFileSync(path.join(dir, 'behavior-baseline.json'))); assert.equal(result.feeHash, baseline.feeHash); assert.equal(result.manualHash, baseline.manualHash); result.preservedAfterRefresh = true; }
 const lockMonth = new Date('2026-06-01');
 const existing = await db.monthlySettlement.findUnique({ where: { settlementMonth: lockMonth } }); assert.equal(existing, null);
 const lock = await db.monthlySettlement.create({ data: { settlementMonth: lockMonth, status: 'locked', lockReason: 'ISOLATED_SIMULATED_LOCK_TEST' } });
 try {
   result.lockHttpStatuses = [];
   for (const route of ['refresh', 'fees', 'adpos', 'sub-id']) {
     const response = await post(route, { settlementMonth: '2026-06', rowKey: fixture.employeeId, subId: fixture.subId, amount: '1', rates: { airwallex: '0.01', photonpay: '0.01', adpos: '0.01' } });
     assert.equal(response.ok, false); result.lockHttpStatuses.push(response.status);
   }
   assert.equal(await db.syncTask.count({ where: { settlementMonth: lockMonth } }), 0);
 } finally { await db.monthlySettlement.delete({ where: { id: lock.id } }); }
 fs.writeFileSync(path.join(dir, 'behavior-' + mode + '-evidence.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
})().catch(e => { console.error('BEHAVIOR_VALIDATION_FAILED', e.code || e.name); process.exitCode = 1; }).finally(() => db.$disconnect());
