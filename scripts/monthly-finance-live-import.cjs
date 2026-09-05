// Decrypt only in memory, then re-encrypt credentials using the isolated environment key.
const fs = require('node:fs');
const path = require('node:path');
const { privateDecrypt, createDecipheriv, createHash } = require('node:crypto');
const { PrismaClient, Prisma } = require('@prisma/client');
const root = path.resolve(__dirname, '..'), dir = path.join(root, 'tmp/monthly-finance-live');
for (const line of fs.readFileSync(path.join(dir, '.env'), 'utf8').split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) process.env[line.slice(0, i)] = line.slice(i + 1); }

(async () => {
  const url = new URL(process.env.DATABASE_URL);
  if (url.hostname !== 'localhost' || url.port !== '35439' || !/^\/monthly_finance_live_[a-f0-9]+$/.test(url.pathname) || process.env.SYNC_PLANNER_ENABLED !== 'false' || process.env.SYNC_AUTO_EXECUTION_ENABLED !== 'false') throw new Error('ISOLATION_GUARD');
  const envelope = JSON.parse(fs.readFileSync(path.join(dir, 'configuration.envelope.json'), 'utf8'));
  const key = privateDecrypt(fs.readFileSync(path.join(dir, 'recipient-private.pem')), Buffer.from(envelope.key, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64')); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  // Confirmed CAKE adjustments need their baseline metadata to remain editable/auditable.
  // Refuse an incomplete export instead of silently importing amount-only adjustments.
  const { readCakeAdjustmentMetadata } = require('../apps/api/dist/apps/api/src/cake-income-adjustments/cake-income-adjustment.utils.js');
  if (data.manualIncome.some(row => row.source === 'cake_adjustment' && !readCakeAdjustmentMetadata(row.rawData))) throw new Error('CAKE_ADJUSTMENT_METADATA_REQUIRED');
  const db = new PrismaClient();
  const { CredentialCryptoService } = require('../apps/api/dist/apps/api/src/common/credential-crypto.service.js');
  const crypto = new CredentialCryptoService();
  try {
    if (await db.affiliateAccount.count() || await db.cardProviderCredential.count()) throw new Error('ALREADY_IMPORTED');
    const user = await db.adminUser.findUniqueOrThrow({ where: { username: 'live-integration' } });
    await db.$transaction(async tx => {
      for (const [index, employee] of data.employees.entries()) await tx.employee.create({ data: { ...employee, name: `联调员工-${index + 1}`, businessSubId: employee.businessSubId || null } });
      for (const account of data.accounts) {
        const { credential, ...fields } = account;
        await tx.affiliateAccount.create({ data: fields });
        await tx.affiliateAccountCredential.create({ data: { id: credential.id, affiliateAccountId: account.id, status: 'active', encryptedPayload: crypto.encryptJson(credential.payload), createdBy: user.id, updatedBy: user.id } });
      }
      const availableAccounts = new Set(data.accounts.map(a => a.id));
      for (const mapping of data.mappings.filter(m => availableAccounts.has(m.affiliateAccountId))) await tx.subIdMapping.create({ data: { ...mapping, createdBy: user.id } });
      for (const credential of data.cardCredentials) await tx.cardProviderCredential.create({ data: { id: credential.id, provider: credential.provider, status: 'active', encryptedPayload: crypto.encryptJson(credential.payload), createdBy: user.id, updatedBy: user.id } });
      for (const card of data.cards) await tx.providerCard.create({ data: card });
      for (const alias of data.aliases) await tx.providerEmailAlias.create({ data: { ...alias, createdBy: user.id, updatedBy: user.id } });
      for (const exclusion of data.exclusions) await tx.providerCardAccountingExclusion.create({ data: { ...exclusion, createdBy: user.id, updatedBy: user.id } });
      for (const fee of data.fees) await tx.monthlyCardProviderFeeRate.create({ data: { ...fee, createdBy: user.id } });
      for (const entry of data.manual) await tx.manualCardSpendEntry.create({ data: { ...entry, createdBy: user.id } });
      for (const income of data.manualIncome) await tx.incomeRecord.create({ data: { ...income, affiliateAccountId: availableAccounts.has(income.affiliateAccountId) ? income.affiliateAccountId : null, importedBy: user.id } });
      const adpos = data.manual.filter(m => m.providerName.trim().toLowerCase() === 'adpos');
      const adposRates = new Set(adpos.map(m => new Prisma.Decimal(m.feeRate).toString()));
      if (adpos.length && adposRates.size === 1 && adpos.every(m => new Prisma.Decimal(m.settledSpendUsd).mul(new Prisma.Decimal(m.feeRate).plus(1)).equals(m.actualSpendUsd))) await tx.monthlyAdposFeeRate.create({ data: { settlementMonth: new Date(data.selectedMonth + '-01'), feeRate: [...adposRates][0], createdBy: user.id } });
    }, { timeout: 60000 });
    const aliases = data.accounts.map((account, index) => ({ id: account.id, code: `A${String(index + 1).padStart(2, '0')}`, systemType: account.platform }));
    fs.writeFileSync(path.join(dir, 'source-aliases.private.json'), JSON.stringify(aliases), { mode: 0o600 });
    const evidence = { candidate: '6853c629785c0227dc49359dc48199edfd239726', importedAt: new Date().toISOString(), selectedMonth: data.selectedMonth, productionExportedAt: data.exportedAt, productionFlags: data.productionFlags, sources: aliases.map(({ code, systemType }) => ({ code, systemType, real: true, validation: 'not_started' })), providers: data.cardCredentials.map(c => c.provider), employees: data.employees.length, mappingVersions: data.mappings.length, retainedProviderCards: data.cards.length, retainedAliases: data.aliases.length, retainedExclusions: data.exclusions.length, retainedManualCosts: data.manual.length, retainedManualIncome: data.manualIncome.length, productionHistoricalAggregates: data.history, productionMigrations: data.migrations, envelopeSHA256: createHash('sha256').update(fs.readFileSync(path.join(dir, 'configuration.envelope.json'))).digest('hex'), importedProductionTasks: false, productionSettlements: data.settlements };
    fs.writeFileSync(path.join(dir, 'import-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ imported: true, selectedMonth: evidence.selectedMonth, sources: evidence.sources, providers: evidence.providers, employees: evidence.employees, cards: evidence.retainedProviderCards, aliases: evidence.retainedAliases, exclusions: evidence.retainedExclusions }));
  } finally { await db.$disconnect(); }
})().catch(() => { console.error('ISOLATED_IMPORT_FAILED_NO_SECRET_OUTPUT'); process.exitCode = 1; });
