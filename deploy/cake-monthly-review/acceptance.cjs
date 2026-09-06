// Read-only business acceptance. No refresh or review mutations are permitted.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const [tokenFile, dir, mode] = process.argv.slice(2), token = fs.readFileSync(tokenFile, 'utf8');
const origin = 'https://api-salary.lovemiemie.com';
async function api(route) {
  const r = await fetch(origin + route, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw Error('FORMAL_HTTP_' + r.status); return r.json();
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
(async () => {
  assert(['baseline', 'verify'].includes(mode));
  const denied = await fetch(origin + '/dashboard/monthly?settlementMonth=2026-07', { signal: AbortSignal.timeout(30000) });
  assert.equal(denied.status, 401);
  await api('/me');
  const months = [], finance = {};
  for (const month of ['2026-07', '2026-08', '2026-09']) {
    const data = await api('/dashboard/monthly?settlementMonth=' + month);
    finance[month] = hash({ totals: data.totals, rates: data.rates, rows: [...data.rows].sort((a,b) => a.key.localeCompare(b.key)), locked: data.locked });
    if (mode === 'verify') {
      assert(Array.isArray(data.cakeReviews) && data.cakeReviews.length > 0);
      const reviews = [];
      for (const review of data.cakeReviews) {
        const details = await api('/cake-income-adjustments?' + new URLSearchParams({ affiliateAccountId: review.key, settlementMonth: month }));
        assert.equal(details.account.id, review.key); assert.equal(details.settlementMonth, month);
        assert.equal(details.review.status, review.status);
        assert.equal(details.review.confirmedAt, null);
        assert.notEqual(review.status, 'confirmed_no_adjustment');
        assert.equal(details.review.confirmedAdjustmentCount, review.confirmedAdjustmentCount);
        reviews.push({ accountName: review.name, status: review.status, confirmedAdjustmentCount: review.confirmedAdjustmentCount, staleAdjustmentCount: review.staleAdjustmentCount, manualConfirmationAt: review.confirmedAt });
      }
      const pp = data.sources.find(s => s.key === 'photonpay');
      if (month === '2026-07') { assert.equal(pp.status, 'completed'); assert.equal(pp.coverageComplete, true); }
      months.push({ month, reviews, photonpayStatus: pp.status, photonpayCoverageComplete: pp.coverageComplete });
    }
  }
  if (mode === 'baseline') fs.writeFileSync(path.join(dir, 'financial-baseline.json'), JSON.stringify(finance));
  else {
    assert.deepEqual(finance, JSON.parse(fs.readFileSync(path.join(dir, 'financial-baseline.json'))));
    fs.writeFileSync(path.join(dir, 'acceptance.json'), JSON.stringify({ at: new Date().toISOString(), months, financeHashesUnchanged: true, authenticatedRead: true, anonymousStatus: denied.status, businessWrites: false, refreshedProviders: false }, null, 2));
  }
  console.log('CAKE_READ_ONLY_' + mode.toUpperCase() + '_PASSED');
})().catch(() => { console.error('SAFE_CAKE_ACCEPTANCE_FAILED'); process.exitCode = 1; });
