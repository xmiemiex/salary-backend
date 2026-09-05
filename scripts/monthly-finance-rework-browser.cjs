/* Real local PostgreSQL + built API/Web; providers absent. Never writes the review schema. */
const { PrismaClient } = require('@prisma/client');
const { chromium, expect } = require('@playwright/test');
const { PERMISSIONS } = require('../packages/shared/dist');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'tmp/monthly-finance-rework');
const treeHash = directory => {
  const entries = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else entries.push(`${path.relative(directory, file)}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`); } };
  walk(directory); return createHash('sha256').update(entries.sort().join('\n')).digest('hex');
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const url = new URL(process.env.DATABASE_URL || 'http://invalid');
  if (url.hostname !== 'localhost' || url.port !== '35439' || url.pathname !== '/monthly_finance') throw new Error('Only isolated local PostgreSQL is allowed.');
  const admin = new PrismaClient(); let db, browser, api, web;
  const schema = `browser_${randomUUID().replaceAll('-', '')}`;
  fs.mkdirSync(output, { recursive: true });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const login = JSON.parse(fs.readFileSync(path.join(root, 'tmp/monthly-finance/login.json')));
  const reviewUser = await admin.adminUser.findUniqueOrThrow({ where: { username: login.username } });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('schema', schema);
  try {
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd: root, env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe' });
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const user = await db.adminUser.create({ data: { username: login.username, displayName: '独立浏览器验收', passwordHash: reviewUser.passwordHash } });
    const role = await db.role.create({ data: { code: 'super_admin', name: 'Browser test administrator' } });
    for (const code of PERMISSIONS) { const permission = await db.permission.upsert({ where: { code }, create: { code, name: code }, update: {} }); await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } }); }
    await db.adminUserRole.create({ data: { adminUserId: user.id, roleId: role.id } });
    const month = new Date('2026-09-01'); const accounts = [];
    for (const name of ['Blitz', 'Atlas', 'Nova', 'Orion', 'Summit', 'Horizon']) accounts.push(await db.affiliateAccount.create({ data: { platform: name === 'Nova' ? 'cake' : 'everflow', accountCode: name, accountName: name } }));
    for (let i = 1; i <= 8; i++) {
      const employee = await db.employee.create({ data: { employeeCode: `browser-${i}`, name: '独立模拟员工', businessSubId: `SUB-10${i}` } });
      for (const [n, account] of accounts.entries()) {
        await db.subIdMapping.create({ data: { employeeId: employee.id, affiliateAccountId: account.id, subField: 'sub1', subValue: `original-${i}-${n}`, effectiveMonth: month } });
        await db.incomeRecord.create({ data: { employeeId: employee.id, affiliateAccountId: account.id, settlementMonth: month, subValue: `original-${i}-${n}`, source: account.platform, incomeUsd: String(250 * i + n * 100), status: 'confirmed', rawData: { fixture: 'SIMULATED_LOCAL_ONLY' } } });
      }
      for (const provider of ['airwallex', 'photonpay']) await db.cardSpendEvent.createMany({ data: Array.from({ length: 45 }, (_, n) => ({ employeeId: employee.id, settlementMonth: month, provider, cardId: `safe-${i}`, externalEventId: `${provider}-${i}-${n}`, transactionAt: new Date('2026-09-02'), spendUsd: String(i * 5), status: 'confirmed' })) });
      await db.manualCardSpendEntry.create({ data: { employeeId: employee.id, settlementMonth: month, providerName: 'Adpos', settledSpendUsd: '100', actualSpendUsd: '103.5', feeRate: '0.035', status: 'confirmed', createdBy: user.id } });
    }
    for (const provider of ['airwallex', 'photonpay']) await db.monthlyCardProviderFeeRate.create({ data: { settlementMonth: month, provider, feeRate: '0.03', createdBy: user.id } });
    await db.monthlyAdposFeeRate.create({ data: { settlementMonth: month, feeRate: '0.035', createdBy: user.id } });
    const apiLog = fs.openSync(path.join(output, 'api.log'), 'w');
    api = spawn(process.execPath, ['apps/api/dist/apps/api/src/main.js'], { cwd: root, windowsHide: true, env: { ...process.env, DATABASE_URL: url.toString(), API_PORT: '3050', CORS_ALLOWED_ORIGIN: 'http://localhost:5190', WEB_ORIGIN: 'http://localhost:5190' }, stdio: ['ignore', apiLog, apiLog] });
    const webLog = fs.openSync(path.join(output, 'web.log'), 'w');
    web = spawn(process.execPath, ['apps/web/node_modules/vite/bin/vite.js', 'preview', 'apps/web', '--port', '5190', '--host', '127.0.0.1', '--strictPort'], { cwd: root, windowsHide: true, stdio: ['ignore', webLog, webLog] });
    for (let i = 0; i < 80; i++) { try { if ((await fetch('http://localhost:3050/health/live')).ok && (await fetch('http://localhost:5190')).ok) break; } catch {} await pause(250); }
    const viewer = await db.adminUser.create({ data: { username: 'browser-viewer', displayName: '只读验收', passwordHash: reviewUser.passwordHash } });
    const viewerRole = await db.role.create({ data: { code: 'audit_viewer', name: 'Read only' } });
    const readPermission = await db.permission.findUniqueOrThrow({ where: { code: 'salary.view_all' } });
    await db.rolePermission.create({ data: { roleId: viewerRole.id, permissionId: readPermission.id } });
    await db.adminUserRole.create({ data: { adminUserId: viewer.id, roleId: viewerRole.id } });
    const auth = await (await fetch('http://localhost:3050/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: viewer.username, password: login.password }) })).json();
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` };
    const firstEmployee = await db.employee.findFirstOrThrow();
    for (const endpoint of ['monthly', 'monthly/status', `monthly/details&rowKey=${firstEmployee.id}`]) {
      const [route, extra] = endpoint.split('&'); const address = `http://localhost:3050/dashboard/${route}?settlementMonth=2026-09${extra ? '&' + extra : ''}`;
      expect((await fetch(address, { headers })).status).toBe(200);
      expect((await fetch(address)).status).toBe(401);
    }
    for (const action of ['fees', 'adpos', 'refresh', 'sub-id']) expect((await fetch(`http://localhost:3050/dashboard/monthly/${action}`, { method: 'POST', headers, body: JSON.stringify({ settlementMonth: '2026-09' }) })).status).toBe(403);
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://localhost:5190');
    await page.getByLabel('用户名').fill(login.username); await page.getByLabel('密码', { exact: true }).fill(login.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    const picker = page.locator('.ant-picker input'); await expect(picker).toBeVisible(); await picker.fill('2026-09'); await picker.press('Enter');
    await expect(page.getByRole('button', { name: 'SUB-101', exact: true })).toBeVisible().catch(async error => { console.log(await page.locator('body').innerText()); await page.screenshot({ path: path.join(output, 'failure.png') }); throw error; });
    // Screenshot animation suppression can retain a zero-size loading icon in the accessible name.
    const clickRefresh = async () => { const button = page.getByRole('button', { name: /刷新数据/ }); await expect(button).not.toHaveClass(/(?:^|\s)ant-btn-loading(?:\s|$)/); await expect(button).toBeEnabled(); await button.click(); };
    const screenshots = [];
    for (const width of [1366, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(page.locator('.finance-table tbody tr.ant-table-row')).toHaveCount(8);
      for (const title of ['统一 SUB ID', '总收入 · USD', '含费总花费 · USD', '毛利 · USD', 'ROI']) {
        const box = await page.getByRole('columnheader', { name: title, exact: true }).boundingBox();
        if (!box || box.x < 0 || box.x + box.width > width) throw new Error(`Core column offscreen: ${title} at ${width}`);
      }
      if (await page.locator('body').evaluate(el => el.scrollWidth > window.innerWidth)) throw new Error('Page overflow');
      await expect(page.getByRole('menuitem', { name: '工资结算', exact: true })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'API 凭证配置', exact: true })).toHaveCount(0);
      const file = `dashboard-${width}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true, animations: 'disabled' }); screenshots.push(file);
    }
    await page.getByRole('button', { name: '本月手续费', exact: true }).click();
    await expect(page.locator('.ant-drawer input').nth(0)).toHaveValue(/^3(?:\.0+)?$/);
    await expect(page.locator('.ant-drawer input').nth(1)).toHaveValue(/^3(?:\.0+)?$/);
    await expect(page.locator('.ant-drawer input').nth(2)).toHaveValue(/^3\.50*$/);
    await page.getByRole('button', { name: /取\s*消/ }).click();
    await page.getByRole('button', { name: 'SUB-101', exact: true }).click();
    await page.getByLabel('明细来源').first().click(); await page.getByText('Airwallex 花费', { exact: true }).click();
    await expect(page.locator('.ant-drawer tbody tr.ant-table-row')).toHaveCount(20);
    await page.locator('.ant-drawer .ant-pagination-item-2').click();
    await expect(page.locator('.ant-drawer .ant-pagination-item-2')).toHaveClass(/active/);
    await page.screenshot({ path: path.join(output, 'details-page-2.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Close', exact: true }).click(); await expect(page.locator('.ant-drawer')).toHaveCount(0);
    await clickRefresh();
    await expect(page.getByText('刷新失败', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('尚未完整覆盖', { exact: false })).toBeVisible();
    // Historical mid-month proof must remain visible but cannot certify the whole month.
    const historicalMonth = new Date('2025-12-01');
    const historicalProof = { version: 1, scope: 'all_accounts_cards', posted: true, from: '2025-11-30T16:00:00.000Z', through: '2025-12-15T00:00:00.000Z', month: '2025-12' };
    await db.incomeRecord.create({ data: { employeeId: firstEmployee.id, settlementMonth: historicalMonth, source: 'browser-historical', incomeUsd: '200', status: 'confirmed', rawData: { fixture: 'SIMULATED_LOCAL_ONLY' } } });
    const historicalSources = [...accounts.map(a => ({ affiliateAccountId: a.id, platform: a.platform, sourceType: 'affiliate_income', taskType: 'affiliate_income' })), ...['airwallex', 'photonpay'].map(provider => ({ provider, platform: provider, sourceType: 'card_spend', taskType: `${provider}_card` }))];
    for (const source of historicalSources) await db.syncTask.create({ data: { ...source, settlementMonth: historicalMonth, status: 'completed', failedCount: 0, finishedAt: new Date('2025-12-15'), requestPayload: { settlementMonth: '2025-12' }, resultPayload: { monthlyCoverage: historicalProof } } });
    await picker.fill('2025-12'); await picker.press('Enter');
    await expect(page.getByText('历史月份尚未覆盖至月末，请补刷', { exact: true })).toHaveCount(8);
    await expect(page.locator('.finance-table tbody tr.ant-table-row')).toHaveCount(1);
    await expect(page.locator('.finance-table tbody tr.ant-table-row').getByText('$200.00', { exact: true })).toHaveCount(3);
    const historicalFile = 'historical-month-incomplete.png';
    await page.screenshot({ path: path.join(output, historicalFile), fullPage: true, animations: 'disabled' }); screenshots.push(historicalFile);
    await clickRefresh();
    await expect(page.getByText('刷新失败', { exact: true })).toHaveCount(8);
    await expect(page.locator('.finance-table tbody tr.ant-table-row').getByText('$200.00', { exact: true })).toHaveCount(3);
    await expect(page.getByText('整月已覆盖', { exact: true })).toHaveCount(0);
    if (errors.length) throw new Error(errors.join('\n'));
    fs.writeFileSync(path.join(output, 'browser-evidence.json'), JSON.stringify({ commit: revision, dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), buildHashes: { api: treeHash(path.join(root, 'apps/api/dist')), web: treeHash(path.join(root, 'apps/web/dist')) }, screenshots, employees: 8, affiliates: 6, realLocalPostgres: true, simulatedProviders: true, isolatedSchema: true, originalReviewInputsUntouched: true, builtWebApiBase: 'http://localhost:3050', verified: ['three viewport core-column bounds', 'collapsed navigation', 'fee values', 'server detail page 2', 'failed refresh and honest coverage', 'three read routes 200/401 and four mutation routes 403'] }, null, 2));
    console.log(`Browser PASS for ${revision}: 1366/1440/1920, 8 employees, 6 affiliates, paged details and preserved input schema.`);
  } finally {
    await browser?.close();
    await Promise.all([api, web].filter(Boolean).map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => { child.once('exit', resolve); child.kill(); })));
    await db?.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.$disconnect();
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
