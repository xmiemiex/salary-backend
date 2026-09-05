// Local-only environment and optional TLS-preserving PhotonPay network comparison.
const fs = require('node:fs'), path = require('node:path'), https = require('node:https');
const dir = path.resolve(__dirname, '../tmp/monthly-finance-live');
for (const line of fs.readFileSync(path.join(dir, '.env'), 'utf8').split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1); }
const target = new URL(process.env.DATABASE_URL);
if (target.hostname !== 'localhost' || target.port !== '35439' || !/^\/monthly_finance_live_[a-f0-9]+$/.test(target.pathname) || process.env.SYNC_PLANNER_ENABLED !== 'false' || process.env.SYNC_AUTO_EXECUTION_ENABLED !== 'false') throw new Error('ISOLATION_GUARD');
const originalFetch = global.fetch;
global.fetch = async (input, init = {}) => {
  const url = new URL(input), started = Date.now(); let status = null;
  try {
    let response;
    const pp = process.env.LIVE_PP_TUNNEL === 'true' && url.hostname === 'x-api.photonpay.com';
    const ef = process.env.LIVE_EF_TUNNEL === 'true' && url.hostname === 'api.eflow.team';
    if (pp || ef) {
      const allowed = pp ? ((init.method === 'POST' && url.pathname === '/oauth2/token/accessToken') || ((init.method || 'GET') === 'GET' && ['/vcc/openApi/v4/pagingVccCard', '/vcc/openApi/v4/getCardDetail', '/vcc/openApi/v4/pagingVccTradeOrder'].includes(url.pathname))) : ((init.method === 'GET' && url.pathname === '/v1/meta/timezones') || (init.method === 'POST' && ['/v1/affiliates/reporting/entity/table', '/v1/affiliates/reporting/conversions'].includes(url.pathname)));
      if (!allowed) throw new Error('READ_ONLY_ROUTE_GUARD');
      response = await new Promise((resolve, reject) => {
        const req = https.request({ hostname: '127.0.0.1', port: pp ? 3063 : 3064, servername: url.hostname, agent: false, method: init.method || 'GET', path: url.pathname + url.search, headers: { ...init.headers, Host: url.hostname }, signal: init.signal }, res => {
          const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])) }))); res.on('error', reject);
        }); req.on('error', error => { fs.appendFileSync(path.join(dir, 'transport-errors.jsonl'), JSON.stringify({ at: new Date().toISOString(), code: error.code || error.name, reusedSocket: req.reusedSocket }) + '\n'); reject(error); }); if (init.body) req.write(init.body); req.end();
      });
    } else response = await originalFetch(input, init);
    status = response.status; return response;
  } finally {
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) fs.appendFileSync(path.join(dir, 'request-metrics.jsonl'), JSON.stringify({ at: new Date().toISOString(), path: url.pathname, query: Object.fromEntries([...url.searchParams].filter(([key]) => ['pageIndex','pageSize','createdAtStart','createdAtEnd','page_num','page_size','from_created_at','to_created_at'].includes(key))), method: init.method || 'GET', status, elapsedMs: Date.now() - started, ppTunnel: process.env.LIVE_PP_TUNNEL === 'true' && url.hostname === 'x-api.photonpay.com' }) + '\n');
  }
};
module.exports = { dir };
