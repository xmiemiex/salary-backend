// At most one July PhotonPay-only refresh. Supplier failures are reported, not converted into deployment failure.
const fs = require('node:fs'), path = require('node:path');
const [tokenFile, dir] = process.argv.slice(2), token = fs.readFileSync(tokenFile, 'utf8');
const origin = 'https://api-salary.lovemiemie.com', month = '2026-07';
async function api(route, body) {
  const r = await fetch(origin + route, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw Error('FORMAL_HTTP_' + r.status); return r.json();
}
function write(data) {
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(path.join(dir, 'acceptance.json'), json, { mode: 0o600 });
  if (process.env.PUBLIC_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.PUBLIC_EVIDENCE_DIR, 'acceptance.json'), json, { mode: 0o644 });
}
function sources(value) { return value.sources.map((s, i) => ({ source: ['photonpay', 'airwallex'].includes(s.key) ? s.key : `A${i + 1}`, status: s.status, reason: s.reason, coverageComplete: s.coverageComplete, coveredThrough: s.coveredThrough, nextAttemptAt: s.nextAttemptAt ?? null })); }
(async () => {
  const denied = await fetch(origin + '/dashboard/monthly?settlementMonth=' + month, { signal: AbortSignal.timeout(30000) });
  if (denied.status !== 401) throw Error('UNAUTHENTICATED_ACCESS');
  await api('/me');
  const first = await api('/dashboard/monthly?settlementMonth=' + month);
  await api('/dashboard/monthly?settlementMonth=2026-08');
  const summary = { startedAt: new Date().toISOString(), formalHttps: true, authenticatedRead: true, unauthenticatedStatus: denied.status, monthSelection: true, month, refreshStarted: false, sources: sources(first), timeline: [] };
  const source = first.sources.find(s => s.key === 'photonpay');
  if (!source) throw Error('PHOTONPAY_SOURCE_MISSING');
  if (process.argv[4] === '--read-only') {
    console.log('FORMAL_AUTHORIZATION_AND_MONTH_READ_PASSED'); return;
  }
  if (first.locked) summary.action = 'SKIPPED_LOCKED_MONTH';
  else if (source.status === 'completed' && source.coverageComplete) summary.action = 'SKIPPED_ALREADY_COMPLETE';
  else if (first.refreshing) summary.action = 'OBSERVE_EXISTING_REFRESH';
  else {
    const refresh = await api('/dashboard/monthly/refresh', { settlementMonth: month, source: 'photonpay' });
    if (!refresh.batchId) throw Error('REFRESH_NOT_ACCEPTED');
    summary.refreshStarted = !refresh.reused; summary.action = refresh.reused ? 'OBSERVE_EXISTING_REFRESH' : 'STARTED_PHOTONPAY_ONLY';
  }
  write(summary);
  let current = first;
  const deadline = Date.now() + 60 * 60 * 1000;
  if (['OBSERVE_EXISTING_REFRESH', 'STARTED_PHOTONPAY_ONLY'].includes(summary.action)) {
    do {
      await new Promise(resolve => setTimeout(resolve, 15000));
      current = await api('/dashboard/monthly/status?settlementMonth=' + month);
      summary.sources = sources(current); summary.refreshing = current.refreshing; write(summary);
      const observed = summary.sources.find(s => s.source === 'photonpay');
      summary.timeline.push({ at: new Date().toISOString(), ...observed }); write(summary);
    } while (current.refreshing && Date.now() < deadline);
  }
  const final = await api('/dashboard/monthly?settlementMonth=' + month);
  const row = final.rows.find(r => Number(r.spends.photonpay) > 0);
  if (row) {
    const q = '/dashboard/monthly/details?settlementMonth=' + month + '&category=photonpay&rowKey=' + encodeURIComponent(row.key);
    const a = await api(q + '&page=1'), b = await api(q + '&page=2');
    if (a.items.length > 20 || b.items.length > 20 || a.items.some(x => b.items.some(y => y.key === x.key))) throw Error('PAGINATION_REGRESSION');
    summary.detailPage1Rows = a.items.length; summary.detailPage2Rows = b.items.length;
  }
  summary.sources = sources(final); summary.finishedAt = new Date().toISOString();
  const pp = final.sources.find(s => s.key === 'photonpay');
  summary.result = pp.status === 'completed' && pp.coverageComplete ? 'PHOTONPAY_FULL_MONTH_COMPLETE' : final.refreshing ? 'PHOTONPAY_PENDING_WITHIN_EXISTING_BUDGET' : 'PHOTONPAY_EXTERNAL_OR_BUSINESS_FAILURE_REQUIRES_REVIEW';
  write(summary); console.log(summary.result);
})().catch(e => { console.error(/^[A-Z_0-9]+$/.test(e.message) ? e.message : 'SAFE_ACCEPTANCE_FAILED'); process.exitCode = 1; });
