require('./monthly-finance-live-runtime.cjs');
const fs = require('node:fs'), path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { MonthlyFinanceService } = require('../apps/api/dist/apps/api/src/dashboard/monthly-finance.service');
const db = new PrismaClient();
(async () => {
  const data = await new MonthlyFinanceService(db, {}).read('2026-08');
  const aliases = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../tmp/monthly-finance-live/source-aliases.private.json')));
  const sources = data.sources.map(s => ({ source: aliases.find(a => a.id === s.key)?.code || s.key, status: s.status }));
  const result = { checkedAt: new Date().toISOString(), method: 'Read-only database through dashboard service; not a new HTTP test', month: '2026-08', sources, pendingUnifiedRows: data.rows.filter(r => r.attributionPending).map((r,i) => ({ alias: 'P' + String(i+1).padStart(2,'0'), distinctSourceSubs: r.subIds.length })), missingRates: data.rates, refreshing: data.refreshing, originalHttpEvidenceIsHistorical: true };
  fs.writeFileSync(path.resolve(__dirname, '../tmp/monthly-finance-release-review/final-snapshot.json'), JSON.stringify(result,null,2));
  fs.writeFileSync(path.resolve(__dirname, '../tmp/monthly-finance-live/http-latest-evidence.json'), JSON.stringify({ superseded: true, reason: 'Pending snapshot was not final; see read-only final snapshot and committed full refresh evidence.', finalSnapshot: '../monthly-finance-release-review/final-snapshot.json', historicalHttpEvidence: '../../docs/release/monthly-finance-live-evidence.json' },null,2));
  console.log(JSON.stringify(result));
})().catch(() => { console.error('SAFE_SNAPSHOT_FAILED'); process.exitCode=1; }).finally(()=>db.$disconnect());
