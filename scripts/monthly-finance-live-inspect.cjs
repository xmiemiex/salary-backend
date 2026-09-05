require('./monthly-finance-live-runtime.cjs');
const fs = require('node:fs'), path = require('node:path'), { privateDecrypt, createDecipheriv } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { CredentialCryptoService } = require('../apps/api/dist/apps/api/src/common/credential-crypto.service');
const dir = path.resolve(__dirname, '../tmp/monthly-finance-live'), db = new PrismaClient();
(async () => {
 const e = JSON.parse(fs.readFileSync(path.join(dir, 'configuration.envelope.json')));
 const key = privateDecrypt(fs.readFileSync(path.join(dir, 'recipient-private.pem')), Buffer.from(e.key, 'base64'));
 const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64')); decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
 const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.ciphertext, 'base64')), decipher.final()]));
 const crypto = new CredentialCryptoService();
 const c = await db.cardProviderCredential.findMany({ where: { provider: 'photonpay', status: 'active' } });
 const original = data.cardCredentials.find(c => c.provider === 'photonpay'); const local = crypto.decryptJson(c[0].encryptedPayload);
 const result = { checkedAt: new Date().toISOString(), photonpay: { activeCount: c.length, sameCredentialId: c[0].id === original.id, exactPayloadMatch: JSON.stringify(local) === JSON.stringify(original.payload), appIdPresent: typeof local.appId === 'string' && !!local.appId, appSecretPresent: typeof local.appSecret === 'string' && !!local.appSecret, productionBase: !local.baseUrl || new URL(local.baseUrl).hostname === 'x-api.photonpay.com', standardTokenPath: !local.tokenPath || local.tokenPath === '/oauth2/token/accessToken' }, scans: await db.providerInventoryScan.findMany({ select: { provider: true, through: true } }), checkpoints: await db.providerInventoryCheckpoint.findMany({ select: { provider: true } }), pendingUnifiedEmployees: await db.employee.count({ where: { businessSubId: null } }), appliedMigrations: data.migrations.map(m => m.migration_name || m.migrationName), localMigrations: fs.readdirSync(path.resolve(__dirname, '../prisma/migrations')).filter(n => /^\d/.test(n)), importedManualCount: data.manual.length, importedManualIncomeCount: data.manualIncome.length };
 result.pendingMigrations = result.localMigrations.filter(m => !result.appliedMigrations.includes(m));
 fs.writeFileSync(path.join(dir, 'configuration-integrity-evidence.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
})().catch(() => { console.error('INSPECTION_FAILED_NO_SECRET_OUTPUT'); process.exitCode = 1; }).finally(() => db.$disconnect());
