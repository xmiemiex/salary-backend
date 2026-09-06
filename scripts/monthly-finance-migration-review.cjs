// Isolated upgrade rehearsal: never imports production data or modifies existing schemas.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'tmp/monthly-finance-release-review');
const target = new URL(process.env.DATABASE_URL);
if (target.hostname !== 'localhost' || target.port !== '35439' || target.pathname !== '/monthly_finance') throw Error('ISOLATED_DATABASE_REQUIRED');
const schema = 'upgrade_' + randomUUID().replaceAll('-', '');
target.searchParams.set('schema', schema);
const admin = new PrismaClient(), db = new PrismaClient({ datasources: { db: { url: target.toString() } } });
const stage = path.join(out, schema), migrations = fs.readdirSync(path.join(root, 'prisma/migrations')).filter(x => /^\d/.test(x)).sort();
const pending = migrations.filter(x => x >= '20260905010000');
function copyMigration(name) { fs.cpSync(path.join(root, 'prisma/migrations', name), path.join(stage, 'migrations', name), { recursive: true }); }
function deploy() { execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', path.join(stage, 'schema.prisma')], { env: { ...process.env, DATABASE_URL: target.toString() }, stdio: 'pipe' }); }
(async () => {
  fs.mkdirSync(stage, { recursive: true });
  fs.copyFileSync(path.join(root, 'prisma/schema.prisma'), path.join(stage, 'schema.prisma'));
  for (const m of migrations.filter(x => !pending.includes(x))) copyMigration(m);
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); deploy();
  const employee = randomUUID(), actor = randomUUID();
  await db.$executeRaw`INSERT INTO employees(id, employee_code, name, updated_at) VALUES (${employee}::uuid,'upgrade-fixture','Upgrade fixture',now())`;
  for (const [month, rate, amount] of [['2026-01-01','0.03','103'],['2026-02-01','0.03','103'],['2026-02-01','0.04','104'],['2026-03-01','0.03','109']]) {
    await db.$executeRaw`INSERT INTO manual_card_spend_entries(id,settlement_month,provider_name,employee_id,settled_spend_usd,fee_rate,actual_spend_usd,status,created_by,updated_at)
      VALUES (${randomUUID()}::uuid,${new Date(month)},'Adpos',${employee}::uuid,100,${rate}::numeric,${amount}::numeric,'confirmed',${actor}::uuid,now())`;
  }
  await db.$executeRaw`INSERT INTO monthly_settlements(id,settlement_month,status,updated_at) VALUES (${randomUUID()}::uuid,'2026-01-01','locked',now())`;
  const before = await db.$queryRaw`SELECT * FROM manual_card_spend_entries ORDER BY id`;
  for (const m of pending) copyMigration(m); deploy();
  assert.deepEqual(await db.$queryRaw`SELECT * FROM manual_card_spend_entries ORDER BY id`, before);
  const rates = await db.monthlyAdposFeeRate.findMany();
  assert.equal(rates.length, 1); assert.equal(rates[0].feeRate.toString(), '0.03');
  assert.equal(rates[0].settlementMonth.toISOString().slice(0,10), '2026-01-01');
  await assert.rejects(db.$executeRaw`UPDATE manual_card_spend_entries SET reason='legacy update' WHERE settlement_month='2026-01-01'`, /MONTH_LOCKED/);
  // Legacy SQL remains readable and writable in open months, subject to the new financial guards.
  await db.$executeRaw`UPDATE manual_card_spend_entries SET reason='legacy update' WHERE settlement_month='2026-02-01'`;
  assert.equal((await db.$queryRaw`SELECT id,employee_code,name FROM employees`).length, 1);
  assert.equal((await db.$queryRaw`SELECT count(*)::int AS count FROM provider_transaction_scans`)[0].count, 0);
  const triggers = await db.$queryRaw`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'monthly_adpos_fee_rates'::regclass AND NOT tgisinternal`;
  assert(triggers.every(t => t.tgenabled === 'O'));
  let oldApplicationBinaryExecuted = false;
  if (process.env.OLD_APP_ROLLBACK_TESTS === '1') {
    const containerTarget = new URL(target); containerTarget.hostname = 'host.docker.internal';
    const code = `const {PrismaClient}=require('@prisma/client'); const db=new PrismaClient(); (async()=>{const e=await db.employee.findMany(); if(e.length!==1)throw Error('OLD_READ_FAILED'); await db.manualCardSpendEntry.updateMany({where:{settlementMonth:new Date('2026-02-01')},data:{reason:'old-client-write'}}); const {SettlementGenerationService}=require('./apps/api/dist/apps/api/src/settlement/settlement-generation.service'); if(typeof SettlementGenerationService!=='function')throw Error('OLD_SERVICE_LOAD_FAILED'); console.log('OLD_APPLICATION_CLIENT_READ_WRITE_AND_SERVICE_LOAD_PASSED');})().catch(()=>{process.exitCode=1}).finally(()=>db.$disconnect());`;
    const output = execFileSync('docker', ['run','--rm','-e','DATABASE_URL','--entrypoint','node','salary-settlement-api:monthly-rollback-review','-e',code], { env:{...process.env,DATABASE_URL:containerTarget.toString()}, encoding:'utf8' });
    assert(output.includes('OLD_APPLICATION_CLIENT_READ_WRITE_AND_SERVICE_LOAD_PASSED')); oldApplicationBinaryExecuted = true;
  }
  const result = { checkedAt: new Date().toISOString(), passed: true, isolatedSchema: schema, priorMigrations: migrations.length - pending.length, pending, existingManualRowsUnchanged: before.length, lockedHistoricalUnambiguousRatePreserved: true, conflictingAndInconsistentRatesNotGuessed: true, triggerReenabled: true, legacySqlReadAndOpenMonthWrite: true, oldApplicationBinaryExecuted: false, rollbackLimitation: 'Additive schema remains readable; new triggers still enforce locks/rates after application rollback. No data down-migration tested or recommended.' };
  result.oldApplicationBinaryExecuted = oldApplicationBinaryExecuted;
  result.oldApplicationValidationScope = 'Rebuilt production source f859d79c2b8f: old generated Prisma client read/open-month write and compiled settlement service load; not the byte-identical production image or full old HTTP regression.';
  fs.writeFileSync(path.join(out, 'migration-evidence.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(async () => { await db.$disconnect(); await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.$disconnect(); });
