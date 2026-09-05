// Real read-only supplier calls; allowlisted evidence only, credentials remain in memory.
const fs = require('node:fs'), path = require('node:path');
const dir = path.resolve(__dirname, '../tmp/monthly-finance-live');
for (const line of fs.readFileSync(path.join(dir, '.env'), 'utf8').split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1); }
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== 'localhost' || url.port !== '35439' || !/^\/monthly_finance_live_[a-f0-9]+$/.test(url.pathname) || process.env.SYNC_PLANNER_ENABLED !== 'false' || process.env.SYNC_AUTO_EXECUTION_ENABLED !== 'false') throw new Error('ISOLATION_GUARD');
const base = '../apps/api/dist/apps/api/src/';
const { PrismaClient } = require('@prisma/client');
const { CredentialCryptoService } = require(base + 'common/credential-crypto.service');
const { CredentialReaderService } = require(base + 'api-credentials/credential-reader.service');
const { withProviderBudget } = require(base + 'sync-tasks/provider-execution-budget');
const { resolveEverflowGmt8Timezone } = require(base + 'sync-tasks/everflow/everflow-income-sync.adapter');
const { AuditService } = require(base + 'audit/audit.service');
const db = new PrismaClient(), credentials = new CredentialReaderService(db, new CredentialCryptoService());
const imported = JSON.parse(fs.readFileSync(path.join(dir, 'import-evidence.json')));
const sources = JSON.parse(fs.readFileSync(path.join(dir, 'source-aliases.private.json')));
const selected = process.argv[2];
const evidence = { candidate: imported.candidate, month: imported.selectedMonth, startedAt: new Date().toISOString(), real: true, sources: [] };
const save = () => fs.writeFileSync(path.join(dir, selected ? `probe-followup-${selected.replace(/[^A-Za-z0-9_-]/g, '-')}-${process.env.LIVE_EF_TUNNEL || process.env.LIVE_PP_TUNNEL ? 'tunnel' : 'direct'}.json` : 'probe-evidence.json'), JSON.stringify(evidence, null, 2));
async function run(source, action) {
  const record = { source, startedAt: new Date().toISOString(), requests: [] }; evidence.sources.push(record);
  const instrumented = async (input, init) => {
    const started = Date.now(); const entry = { method: init.method, elapsedMs: 0 }; record.requests.push(entry);
    try { const response = await fetch(input, init); entry.httpStatus = response.status; entry.retryAfter = response.headers.get('retry-after'); return response; }
    finally { entry.elapsedMs = Date.now() - started; }
  };
  try { Object.assign(record, await withProviderBudget(180000, () => action(instrumented))); record.passed = true; }
  catch (e) { record.passed = false; record.error = { category: e.category || 'LOCAL_OR_VALIDATION_ERROR', httpStatus: e.httpStatus || null, providerCode: e.providerCode || null, providerMessage: e.providerMessage || null }; }
  record.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify(record));
}
(async () => {
  const user = await db.adminUser.findUniqueOrThrow({ where: { username: 'live-integration' } });
  const actor = { userId: user.id, roleCode: 'super_admin', ipAddress: '127.0.0.1', userAgent: 'isolated-real-api-validation' };
  for (const source of sources.filter(s => !selected || selected.split(',').includes(s.code))) await run(source.code, async instrumented => {
    const { payload: credential, affiliateAccountCode } = await credentials.getAffiliateAccountCredentialPayload(source.id);
    const month = imported.selectedMonth;
    let smallWindow, calibration;
    if (source.systemType === 'everflow') {
      const { EverflowClient } = require(base + 'sync-tasks/everflow/everflow-client');
      const client = new EverflowClient(instrumented);
      const tz = resolveEverflowGmt8Timezone((await client.getTimezones(credential)).timezones || []);
      if (!tz) throw new Error('TIMEZONE_UNRESOLVED');
      const result = await client.getAffiliateSubRevenueSummary({ credential, from: month + '-01 00:00:00', to: month + '-01 23:59:59', timezoneId: tz.timezoneId, subField: 'sub1' });
      smallWindow = { from: month + '-01', days: 1, rows: (result.table || []).length, complete: result.incomplete_results !== true, timezoneId: tz.timezoneId };
      const { EverflowCalibrationService } = require(base + 'sync-tasks/everflow/everflow-calibration.service');
      calibration = await new EverflowCalibrationService(db, credentials, client, new AuditService(db)).run(source.id, { settlementMonth: month }, actor);
      if (source.code === 'A02' && selected === 'A02') {
        const { Prisma } = require('@prisma/client');
        let page = 1, count = 0, declaredTotal = null, revenue = new Prisma.Decimal(0), complete = false;
        do {
          const report = await client.searchAffiliateConversions({ credential, from: month + '-01 00:00:00', to: month + '-31 23:59:59', timezoneId: tz.timezoneId, page, pageSize: 100 });
          const rows = report.conversions || []; count += rows.length; declaredTotal = report.paging?.total_count ?? null;
          for (const row of rows) if (row.revenue != null) revenue = revenue.plus(String(row.revenue));
          complete = declaredTotal !== null ? count >= declaredTotal : rows.length < 100;
          page++;
        } while (!complete && page <= 20);
        smallWindow.fullMonthConversionCrossCheck = { pages: page - 1, count, declaredTotal, complete, revenue: revenue.toString(), independentPortal: false };
      }
    } else {
      const { CakeClient } = require(base + 'sync-tasks/cake/cake-client');
      const client = new CakeClient(instrumented);
      const result = await client.getSubAffiliateSummary({ credential, affiliateId: affiliateAccountCode, startDate: month + '-01', endDate: month + '-02' });
      smallWindow = { from: month + '-01', days: 1, rows: result.rows.length, declaredRows: result.rowCount, timezone: 'provider_native_unconfirmed' };
      const { CakeCalibrationService } = require(base + 'sync-tasks/cake/cake-calibration.service');
      calibration = await new CakeCalibrationService(db, credentials, client, new AuditService(db)).run(source.id, { settlementMonth: month }, actor);
    }
    return { smallWindow, fullMonthCalibration: { writeGateEligible: calibration.writeGateEligible, returnedCount: calibration.returnedCount, revenue: calibration.revenue, httpStatuses: calibration.httpStatuses }, independentPortalReconciled: false };
  });
  for (const provider of imported.providers.filter(p => !selected || selected.split(',').includes(p))) await run(provider, async instrumented => {
    const { payload: credential } = await credentials.getCardProviderCredentialPayload(provider);
    const module = require(base + `sync-tasks/${provider}/${provider}-client`);
    const client = new (provider === 'airwallex' ? module.AirwallexClient : module.PhotonPayClient)(instrumented);
    const from = new Date(imported.selectedMonth + '-01T00:00:00+08:00'), to = new Date(imported.selectedMonth + '-02T00:00:00+08:00');
    let page = provider === 'airwallex' ? 0 : 1, pages = 0, rows = 0, more;
    do { const result = await client.listCardTransactions({ credential, from, to, page, pageSize: 100 }); rows += result.transactions.length; more = result.hasMore; pages++; page++; } while (more && pages < 20);
    return { smallWindow: { from: from.toISOString(), to: to.toISOString(), pages, rows, complete: !more }, fullMonthVerified: false };
  });
  evidence.finishedAt = new Date().toISOString(); save();
})().catch(() => { console.error('PROBE_FAILED_NO_SECRET_OUTPUT'); process.exitCode = 1; }).finally(() => db.$disconnect());
