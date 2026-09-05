require('./monthly-finance-live-runtime.cjs');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const dir = path.resolve(__dirname, '../tmp/monthly-finance-live');
(async () => {
 const browser = await chromium.launch({ channel: 'msedge', headless: true });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = []; page.on('pageerror', () => errors.push('PAGE_ERROR'));
  const login = JSON.parse(fs.readFileSync(path.join(dir, 'login.json')));
  await page.goto('http://localhost:5191'); await page.getByLabel('用户名').fill(login.username); await page.getByLabel('密码', { exact: true }).fill(login.password); await page.getByRole('button', { name: /登\s*录/ }).click();
  const picker = page.locator('.ant-picker input'); await expect(picker).toBeVisible(); await picker.fill('2026-08'); await picker.press('Enter');
  await expect(page.getByRole('button', { name: 'LIVE-VALIDATION-001', exact: true })).toBeVisible();
  for (const title of ['统一 SUB ID', '总收入 · USD', '含费总花费 · USD', '毛利 · USD', 'ROI']) await expect(page.getByRole('columnheader', { name: title, exact: true })).toBeVisible();
  const rows = await page.locator('.finance-table tbody tr.ant-table-row').count();
  const { PrismaClient } = require('@prisma/client'); const db = new PrismaClient();
  const event = await db.cardSpendEvent.findFirstOrThrow({ where: { provider: 'photonpay', employeeId: { not: null }, settlementMonth: new Date('2026-08-01'), status: 'confirmed' } }); await db.$disconnect();
  await page.locator(`.finance-table tr[data-row-key="${event.employeeId}"] button`).first().click();
  await page.getByLabel('明细来源').first().click(); await page.getByText('PhotonPay 花费', { exact: true }).click();
  await expect.poll(() => page.locator('.ant-drawer tbody tr.ant-table-row').count()).toBeGreaterThan(0);
  const detailRows = await page.locator('.ant-drawer tbody tr.ant-table-row').count(); assert.ok(detailRows <= 20);
  const result = { at: new Date().toISOString(), url: 'http://localhost:5191', month: '2026-08', browser: 'Edge', realApi: 'http://localhost:3061', syntheticManualFixture: true, coreColumnsVisible: true, employeeRows: rows, detailRows, pageErrors: errors.length }; assert.equal(errors.length, 0);
  fs.writeFileSync(path.join(dir, 'browser-evidence.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
 } finally { await browser.close(); }
})().catch(() => { console.error('LIVE_BROWSER_VALIDATION_FAILED_NO_SECRET_OUTPUT'); process.exitCode = 1; });
