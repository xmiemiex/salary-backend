const { PrismaClient } = require('@prisma/client');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { PasswordHashService } = require('../apps/api/dist/apps/api/src/auth/password-hash.service.js');
(async () => {
 const target = new URL(process.env.DATABASE_URL || 'http://invalid'); if (target.hostname !== 'localhost' || target.port !== '35439' || target.pathname !== '/monthly_finance') throw new Error('Local fixture is restricted to localhost:35439/monthly_finance.'); const db = new PrismaClient();
 const password = 'Local-' + randomBytes(24).toString('hex');
 const user = await db.adminUser.upsert({ where: { username: 'monthly-review' }, create: { username: 'monthly-review', displayName: '本地验收', passwordHash: await new PasswordHashService().hash(password) }, update: { passwordHash: await new PasswordHashService().hash(password) } });
 const role = await db.role.findUnique({ where: { code: 'super_admin' } });
 await db.adminUserRole.upsert({ where: { adminUserId_roleId: { adminUserId: user.id, roleId: role.id } }, create: { adminUserId: user.id, roleId: role.id }, update: {} });
 const month = new Date('2026-09-01T00:00:00Z');
 const employee = await db.employee.upsert({ where: { employeeCode: 'LOCAL-DEMO-001' }, create: { employeeCode: 'LOCAL-DEMO-001', name: '本地模拟样例', businessSubId: 'SUB-001' }, update: {} });
 for (const [i, amount] of ['2000','3000','5000'].entries()) {
  const platform = i === 2 ? 'cake' : 'everflow';
  const account = await db.affiliateAccount.upsert({ where: { platform_accountCode: { platform, accountCode: `local-demo-${i}` } }, create: { platform, accountCode: `local-demo-${i}`, accountName: ['Blitz','Atlas','Nova'][i] }, update: {} });
  await db.subIdMapping.upsert({ where: { affiliateAccountId_subField_subValue_effectiveMonth: { affiliateAccountId: account.id, subField: 'sub1', subValue: `original-${i}`, effectiveMonth: month } }, create: { affiliateAccountId: account.id, subField: 'sub1', subValue: `original-${i}`, effectiveMonth: month, employeeId: employee.id }, update: {} });
  await db.incomeRecord.upsert({ where: { source_externalRecordId: { source: platform, externalRecordId: `local-demo-${i}` } }, create: { settlementMonth: month, employeeId: employee.id, affiliateAccountId: account.id, source: platform, externalRecordId: `local-demo-${i}`, incomeUsd: amount, subValue: `original-${i}`, status: 'confirmed', rawData: { fixture: 'SIMULATED_LOCAL_ONLY' } }, update: {} });
 }
 for (const [provider, amount] of [['airwallex','1000'],['photonpay','2000']]) {
  await db.cardSpendEvent.upsert({ where: { provider_externalEventId: { provider, externalEventId: `local-demo-${provider}` } }, create: { settlementMonth: month, employeeId: employee.id, provider, cardId: `local-demo-${provider}`, externalEventId: `local-demo-${provider}`, transactionAt: new Date('2026-09-02T02:00:00Z'), settledAt: new Date('2026-09-03T02:00:00Z'), status: 'confirmed', spendUsd: amount, rawData: { fixture: 'SIMULATED_LOCAL_ONLY' } }, update: {} });
 }
 fs.writeFileSync('tmp/monthly-finance/login.json', JSON.stringify({ username: user.username, password }));
 await db.$disconnect();
 console.log('Local simulated sample ready; random login stored locally, no third-party credentials configured.');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
