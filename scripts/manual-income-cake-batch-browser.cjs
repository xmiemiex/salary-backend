/* Real local PostgreSQL + built API/Web; providers absent. Never writes the review schema. */
const { PrismaClient, Prisma } = require('@prisma/client');
const { chromium, expect } = require('@playwright/test');
const { PERMISSIONS } = require('../packages/shared/dist');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'tmp/manual-income-cake-batch');
const treeHash = directory => {
  const entries = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else entries.push(`${path.relative(directory, file)}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`); } };
  walk(directory); return createHash('sha256').update(entries.sort().join('\n')).digest('hex');
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const url = new URL(process.env.DATABASE_URL || 'http://invalid');
  if (url.hostname !== 'localhost' || url.port !== '35439' || url.pathname !== '/monthly_finance') throw new Error('Only isolated local PostgreSQL is allowed.');
  const admin = new PrismaClient(); let db, browser, api, web, passed = false;
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
    for (const name of ['Influx', 'Blitzads', 'Nova', 'Orion', 'Summit', 'Horizon']) accounts.push(await db.affiliateAccount.create({ data: { platform: name === 'Nova' ? 'cake' : 'everflow', accountCode: name, accountName: name } }));
    for (let i = 1; i <= 8; i++) {
      const employee = await db.employee.create({ data: { employeeCode: `browser-${i}`, name: '独立模拟员工', businessSubId: `SUB-10${i}` } });
      for (const [n, account] of accounts.entries()) {
        await db.subIdMapping.create({ data: { employeeId: employee.id, affiliateAccountId: account.id, subField: 'sub1', subValue: `original-${i}-${n}`, effectiveMonth: month } });
        await db.incomeRecord.create({ data: { employeeId: employee.id, affiliateAccountId: account.id, settlementMonth: month, subField: 'sub1', subValue: `original-${i}-${n}`, source: account.platform, incomeUsd: String(250 * i + n * 100), status: 'confirmed', rawData: { fixture: 'SIMULATED_LOCAL_ONLY' } } });
      }
      for (const provider of ['airwallex', 'photonpay']) await db.cardSpendEvent.createMany({ data: Array.from({ length: 45 }, (_, n) => ({ employeeId: employee.id, settlementMonth: month, provider, cardId: `safe-${i}`, externalEventId: `${provider}-${i}-${n}`, transactionAt: new Date('2026-09-02'), spendUsd: String(i * 5), status: 'confirmed' })) });
      await db.manualCardSpendEntry.create({ data: { employeeId: employee.id, settlementMonth: month, providerName: 'Adpos', settledSpendUsd: '100', actualSpendUsd: '103.5', feeRate: '0.035', status: 'confirmed', createdBy: user.id } });
    }
    for (const provider of ['airwallex', 'photonpay']) await db.monthlyCardProviderFeeRate.create({ data: { settlementMonth: month, provider, feeRate: '0.03', createdBy: user.id } });
    await db.monthlyAdposFeeRate.create({ data: { settlementMonth: month, feeRate: '0.035', createdBy: user.id } });
    const apiLog = fs.openSync(path.join(output, 'api.log'), 'w');
    api = spawn(process.execPath, ['apps/api/dist/apps/api/src/main.js'], { cwd: root, windowsHide: true, env: { ...process.env, DATABASE_URL: url.toString(), API_PORT: '3050', SYNC_PLANNER_ENABLED: 'false', SYNC_AUTO_EXECUTION_ENABLED: 'false', CORS_ALLOWED_ORIGIN: 'http://localhost:5190', WEB_ORIGIN: 'http://localhost:5190' }, stdio: ['ignore', apiLog, apiLog] });
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
    const owner = await db.employee.findUniqueOrThrow({ where: { employeeCode: 'browser-1' } });
    const cakeAccount = accounts.find(a => a.platform === 'cake');
    // Exactly 25 CAKE rows: 20 on the first page, 5 on the second.
    for (let i = 0; i < 17; i++) {
      const subValue = `BATCH-${String(i).padStart(2, '0')}`;
      await db.subIdMapping.create({ data: { employeeId: owner.id, affiliateAccountId: cakeAccount.id, subField: 'sub1', subValue, effectiveMonth: month } });
      await db.incomeRecord.create({ data: { employeeId: owner.id, affiliateAccountId: cakeAccount.id, settlementMonth: month, source: 'cake', subField: 'sub1', subValue, incomeUsd: '0.1', status: 'confirmed', rawData: { fixture: 'SIMULATED_LOCAL_ONLY' } } });
    }
    const native = await db.incomeRecord.findMany({ where: { affiliateAccountId: cakeAccount.id, settlementMonth: month, source: 'cake' } });
    for (const row of native) await db.incomeRecord.create({ data: { employeeId: row.employeeId, affiliateAccountId: cakeAccount.id, settlementMonth: month, source: 'cake_adjustment', subField: 'sub1', subValue: row.subValue, incomeUsd: '0.1', status: 'draft', rawData: { kind: 'cake_sub_revenue_adjustment', baseRevenueUsd: row.incomeUsd.toString(), targetRevenueUsd: row.incomeUsd.plus('0.1').toString(), adjustmentUsd: '0.1', reason: 'SIMULATED_LOCAL_ONLY', stale: false } } });
    const oldManual = await db.incomeRecord.create({ data: { employeeId: owner.id, settlementMonth: month, source: 'legacy-note', incomeUsd: '30', status: 'confirmed', rawData: { reason: '保留原备注' } } });
    const untouchedManual = await db.incomeRecord.create({ data: { employeeId: owner.id, settlementMonth: month, source: 'manual', incomeUsd: '20', status: 'confirmed' } });
    for (const route of ['/dashboard/monthly/manual-income', '/cake-income-adjustments/batch/confirm', '/cake-income-adjustments/batch/disable']) expect((await fetch('http://localhost:3050' + route, { method: 'POST', headers, body: JSON.stringify({ settlementMonth: '2026-09', rowKey: owner.id }) })).status).toBe(403);
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://localhost:5190');
    await page.getByLabel('用户名').fill(login.username); await page.getByLabel('密码', { exact: true }).fill(login.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    const picker = page.locator('.ant-picker input'); await expect(picker).toBeVisible(); await picker.fill('2026-09'); await picker.press('Enter'); await picker.press('Tab');
    await expect(page.getByRole('button', { name: 'SUB-101', exact: true })).toBeVisible();
    const token = await page.evaluate(() => sessionStorage.getItem('salary_admin_session_token'));
    const apiRead = async route => { const result = await fetch('http://localhost:3050' + route, { headers: { authorization: 'Bearer ' + token } }); expect(result.status).toBe(200); return result.json(); };
    const before = await apiRead('/dashboard/monthly?settlementMonth=2026-09'), taskCount = await db.syncTask.count();
    await page.getByRole('button', { name: 'SUB-101', exact: true }).click();
    await page.getByRole('button', { name: '编辑其他手动收入', exact: true }).click();
    const drawer = page.locator('.ant-drawer');
    await expect(drawer.getByText('已计入手动收入合计 $50.00', { exact: false })).toBeVisible();
    await drawer.getByLabel('此条收入金额 USD').fill('12.34'); await drawer.getByLabel('收入备注').fill('本页新增验证');
    await drawer.getByRole('button', { name: '新增并计入收入', exact: true }).click();
    await expect(drawer.getByText('已计入手动收入合计 $62.34', { exact: false })).toBeVisible();
    await drawer.locator('tbody tr').filter({ hasText: 'legacy-note' }).getByRole('button', { name: '编辑条目', exact: true }).click();
    await drawer.getByLabel('此条收入金额 USD').fill('5.67'); await drawer.getByRole('button', { name: '保存此条金额', exact: true }).click();
    await expect(drawer.getByText('已计入手动收入合计 $38.01', { exact: false })).toBeVisible();
    const changed = await db.incomeRecord.findUniqueOrThrow({ where: { id: oldManual.id } });
    expect(changed).toMatchObject({ source: oldManual.source, rawData: oldManual.rawData, status: oldManual.status }); expect(changed.incomeUsd.toString()).toBe('5.67');
    expect(await db.incomeRecord.findUnique({ where: { id: untouchedManual.id } })).toEqual(untouchedManual);
    await page.setViewportSize({ width: 1024, height: 1000 });
    await page.screenshot({ path: path.join(output, 'manual-income-1024.png'), fullPage: true });
    await page.route('**/dashboard/monthly/manual-income', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: '隔离模拟保存失败' }) }));
    await drawer.getByLabel('此条收入金额 USD').fill('999'); await drawer.getByRole('button', { name: '新增并计入收入', exact: true }).click();
    await expect(drawer.getByRole('alert')).toBeVisible();
    expect((await apiRead(`/dashboard/monthly/manual-income?settlementMonth=2026-09&rowKey=${owner.id}`)).confirmedTotal).toBe('38.01');
    await page.unroute('**/dashboard/monthly/manual-income'); await drawer.getByRole('button', { name: 'Close', exact: true }).click();
    const after = await apiRead('/dashboard/monthly?settlementMonth=2026-09');
    expect(new Prisma.Decimal(after.totals.totalIncome).minus(before.totals.totalIncome).toString()).toBe('-11.99');
    expect(after.rows.find(row => row.key === owner.id).otherIncome).toBe('38.01'); expect(await db.syncTask.count()).toBe(taskCount);

    await page.goto(`http://localhost:5190/cake-income-adjustments?affiliateAccountId=${cakeAccount.id}&settlementMonth=2026-09`);
    await expect(page.getByText('CAKE SUB 月度收入调整', { exact: true })).toBeVisible();
    const table = page.locator('.ant-table-wrapper').first();
    await expect(table.locator('tbody tr.ant-table-row')).toHaveCount(20);
    const getList = () => apiRead(`/cake-income-adjustments?affiliateAccountId=${cakeAccount.id}&settlementMonth=2026-09`);
    let list = await getList();
    const assertFooter = async rows => {
      const values = [rows.map(r => r.baseRevenueUsd), rows.map(r => r.previousBaseRevenueUsd ?? r.baseRevenueUsd), rows.map(r => r.actualRevenueUsd).filter(v => v != null), rows.map(r => r.adjustmentUsd), rows.map(r => r.previewRevenueUsd)];
      const cells = table.locator('tfoot td');
      await expect(cells.nth(0)).toHaveText('当前页合计');
      for (let i = 0; i < values.length; i++) {
        const value = values[i].reduce((sum, v) => sum.plus(v), new Prisma.Decimal(0)).toFixed(6);
        const [whole, fraction] = value.split('.'), expected = '$' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + fraction.replace(/0+$/, '').padEnd(2, '0');
        await expect(cells.nth(i + 1)).toHaveText(values[i].length ? expected : '—');
      }
    };
    await assertFooter(list.items.slice(0, 20));
    await page.getByRole('checkbox', { name: '全选当前页', exact: true }).check(); await expect(page.getByText('已选 20 条', { exact: true })).toBeVisible();
    await table.locator('.ant-pagination-item-2').click(); await expect(page.getByText('已选 0 条', { exact: true })).toBeVisible();
    await expect(table.locator('tbody tr.ant-table-row')).toHaveCount(5); await assertFooter(list.items.slice(20));
    await page.getByRole('checkbox', { name: '全选当前页', exact: true }).check(); await expect(page.getByText('已选 5 条', { exact: true })).toBeVisible();
    const batchButton = page.getByRole('button', { name: '确认所选', exact: true });
    const buttonBox = await batchButton.boundingBox(); expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(1024);
    await batchButton.click(); await expect(page.locator('.ant-modal-confirm')).toContainText('确认所选 5 条调整');
    await page.locator('.ant-modal-confirm').getByRole('button', { name: '确认计入所选', exact: true }).click();
    await expect(page.locator('.ant-modal-confirm')).toHaveCount(0); await expect(page.getByText('已选 0 条', { exact: true })).toBeVisible();
    expect(await db.incomeRecord.count({ where: { affiliateAccountId: cakeAccount.id, source: 'cake_adjustment', status: 'confirmed' } })).toBe(5);
    expect(await db.incomeRecord.count({ where: { affiliateAccountId: cakeAccount.id, source: 'cake_adjustment', status: 'draft' } })).toBe(20);
    await page.getByRole('checkbox', { name: '全选当前页', exact: true }).check(); await expect(batchButton).toBeDisabled();
    await page.getByRole('button', { name: '停用所选', exact: true }).click();
    await page.locator('.ant-modal-confirm').getByRole('button', { name: '确认停用所选', exact: true }).click();
    await expect(page.locator('.ant-modal-confirm')).toHaveCount(0); await expect(page.getByRole('checkbox', { name: '全选当前页', exact: true })).toBeDisabled();
    expect(await db.incomeRecord.count({ where: { affiliateAccountId: cakeAccount.id, source: 'cake_adjustment', status: 'disabled' } })).toBe(5);
    await table.locator('.ant-pagination-item-1').click();
    const firstSub = list.items[0].subValue;
    await page.getByLabel('选择 ' + firstSub, { exact: true }).check();
    await page.getByLabel('调整月份').fill('2026-08'); await expect(page.getByText('已选 0 条', { exact: true })).toBeVisible();
    await page.getByLabel('调整月份').fill('2026-09'); await expect(table.locator('tbody tr.ant-table-row')).toHaveCount(20);
    await page.getByLabel('选择 ' + firstSub, { exact: true }).check();
    await page.getByRole('button', { name: '刷新基础记录显示', exact: true }).click(); await expect(page.getByText('已选 1 条', { exact: true })).toBeVisible();
    // Real draft edit via modal, then reselect the refreshed version.
    await table.locator('tbody tr').filter({ hasText: firstSub }).getByRole('button', { name: '编辑草稿', exact: true }).click();
    await page.getByLabel('China Standard Time 实际 Revenue (USD)', { exact: true }).fill('0.3');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByText('已选 0 条', { exact: true })).toBeVisible();
    list = await getList(); await assertFooter(list.items.slice(0, 20));
    await page.getByLabel('选择 ' + firstSub, { exact: true }).check();
    const baseRow = await db.incomeRecord.findFirstOrThrow({ where: { affiliateAccountId: cakeAccount.id, source: 'cake', subValue: firstSub } });
    await db.incomeRecord.update({ where: { id: baseRow.id }, data: { incomeUsd: '0.2' } });
    await batchButton.click(); await page.locator('.ant-modal-confirm').getByRole('button', { name: '确认计入所选', exact: true }).click();
    await expect(page.getByText(/整批未处理/).first()).toBeVisible();
    expect(await db.incomeRecord.count({ where: { affiliateAccountId: cakeAccount.id, source: 'cake_adjustment', status: 'confirmed' } })).toBe(0);
    await page.locator('.ant-modal-confirm').getByRole('button', { name: /返\s*回/ }).click();
    await db.incomeRecord.update({ where: { id: baseRow.id }, data: { incomeUsd: baseRow.incomeUsd } });
    await page.getByRole('button', { name: '刷新基础记录显示', exact: true }).click();
    await page.mouse.move(0, 0);
    await expect(page.locator('.ant-message-notice')).toHaveCount(0, { timeout: 15000 });
    await page.screenshot({ path: path.join(output, 'cake-batch-1024.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(output, 'cake-batch-1440.png'), fullPage: true });
    await table.locator('.ant-table-content').evaluate(element => { element.scrollLeft = 350; });
    await page.screenshot({ path: path.join(output, 'cake-money-columns-1440.png'), fullPage: true });
    if (errors.length) throw Error(errors.join('\n'));
    fs.writeFileSync(path.join(output, 'browser-evidence.json'), JSON.stringify({ revision, dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), at: new Date().toISOString(), apiBuild: treeHash(path.join(root, 'apps/api/dist')), webBuild: treeHash(path.join(root, 'apps/web/dist')), isolatedSchema: true, simulatedOnly: true, realBrowser: 'Edge', widths: [1024, 1440], manualAddEditAndFailure: true, oldSourcesNotesAndUnselectedRowsPreserved: true, totalsAndRoiRefreshed: true, noSupplierCalls: true, cakeFiveMoneyColumnTotals: true, selectAll20ThenPage2Only5: true, monthSwitchClearsSelection: true, draftSaveAndBatchConfirmDisable: true, baselineChangedBatchRejected: true, readonly403: true, pageErrors: 0 }, null, 2));
    passed = true;
    console.log('MANUAL_INCOME_AND_CAKE_BATCH_BROWSER_PASS');
  } finally {
    await browser?.close();
    const keep = passed && process.env.KEEP_LOCAL_REVIEW === '1';
    if (keep) {
      api.unref(); web.unref();
      fs.writeFileSync(path.join(output, 'local-preview.json'), JSON.stringify({ schema, apiPid: api.pid, webPid: web.pid, url: 'http://localhost:5190', month: '2026-09', simulatedOnly: true, revision }, null, 2));
    } else await Promise.all([api, web].filter(Boolean).map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => { child.once('exit', resolve); child.kill(); })));
    await db?.$disconnect();
    if (!keep) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.$disconnect();
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });



