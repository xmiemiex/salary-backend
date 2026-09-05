// Prepares a separate LOCAL database. Never accepts a remote production database URL.
const { PrismaClient } = require('@prisma/client');
const { randomBytes, generateKeyPairSync } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'tmp/monthly-finance-live');

(async () => {
  const source = new URL(process.env.DATABASE_URL || 'http://invalid');
  if (source.hostname !== 'localhost' || source.port !== '35439' || source.pathname !== '/monthly_finance') throw new Error('Expected the existing isolated localhost:35439/monthly_finance instance.');
  fs.mkdirSync(directory, { recursive: true });
  const privateEnvPath = path.join(directory, '.env');
  if (fs.existsSync(privateEnvPath)) throw new Error('An integration environment already exists; preserve it and resume rather than overwriting it.');
  const database = 'monthly_finance_live_' + randomBytes(6).toString('hex');
  const admin = new PrismaClient();
  await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  await admin.$disconnect();
  source.pathname = '/' + database;
  source.searchParams.set('schema', 'public');
  const env = {
    DATABASE_URL: source.toString(), API_PORT: '3061', WEB_PORT: '5191',
    CORS_ALLOWED_ORIGIN: 'http://localhost:5191', VITE_API_BASE_URL: 'http://localhost:3061',
    API_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ADMIN_SESSION_TTL_SECONDS: '43200', SYNC_PLANNER_ENABLED: 'false', SYNC_AUTO_EXECUTION_ENABLED: 'false',
    SYNC_AUTO_EXECUTION_BATCH_SIZE: '2', SYNC_AUTO_EXECUTION_MAX_ATTEMPTS: '3',
    SYNC_AUTO_EXECUTION_LEASE_SECONDS: '900', SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS: '300',
  };
  fs.writeFileSync(privateEnvPath, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  const keys = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  fs.writeFileSync(path.join(directory, 'recipient-public.pem'), keys.publicKey);
  fs.writeFileSync(path.join(directory, 'recipient-private.pem'), keys.privateKey, { mode: 0o600 });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd: root, env: { ...process.env, ...env }, stdio: 'pipe' });
  const db = new PrismaClient({ datasources: { db: { url: source.toString() } } });
  const { PasswordHashService } = require('../apps/api/dist/apps/api/src/auth/password-hash.service.js');
  const { PERMISSIONS } = require('../packages/shared/dist');
  const password = 'Live-' + randomBytes(24).toString('hex');
  const user = await db.adminUser.create({ data: { username: 'live-integration', displayName: '隔离联调', passwordHash: await new PasswordHashService().hash(password) } });
  const role = await db.role.create({ data: { code: 'super_admin', name: 'Isolated integration administrator' } });
  for (const code of PERMISSIONS) {
    const permission = await db.permission.upsert({ where: { code }, create: { code, name: code }, update: {} });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  }
  await db.adminUserRole.create({ data: { adminUserId: user.id, roleId: role.id } });
  fs.writeFileSync(path.join(directory, 'login.json'), JSON.stringify({ username: user.username, password }), { mode: 0o600 });
  const evidence = { candidate: '6853c629785c0227dc49359dc48199edfd239726', preparedAt: new Date().toISOString(), database, host: 'localhost', port: 35439, apiPort: 3061, webPort: 5191, schedulerEnabled: false, automaticExecutionEnabled: false, activeAffiliateCredentials: await db.affiliateAccountCredential.count(), activeCardCredentials: await db.cardProviderCredential.count(), taskCount: await db.syncTask.count(), transport: 'Recipient public key prepared; no production credentials exported or imported', productionDatabaseCopied: false };
  fs.writeFileSync(path.join(directory, 'environment-evidence.json'), JSON.stringify(evidence, null, 2));
  await db.$disconnect();
  console.log(JSON.stringify(evidence));
})().catch(() => { console.error('Isolated environment setup failed; no credential values are printed. Inspect only redacted operational evidence.'); process.exitCode = 1; });
