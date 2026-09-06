const { PrismaClient } = require('@prisma/client'), fs = require('node:fs'), { createHash } = require('node:crypto');
const db = new PrismaClient(), hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
(async () => {
  const rows = await db.cardSpendEvent.findMany({ where: { settlementMonth: new Date('2026-07-01') }, orderBy: { id: 'asc' } });
  const seen = new Set(); let duplicates = 0;
  for (const row of rows) if (row.externalEventId) { const key = row.provider + ':' + row.externalEventId; if (seen.has(key)) duplicates++; seen.add(key); }
  const fingerprints = Object.fromEntries(rows.map(row => [hash(row.id), hash(row)]));
  if (process.argv[2] === 'before') { console.log(JSON.stringify({ count: rows.length, fingerprints, duplicates })); return; }
  const old = JSON.parse(fs.readFileSync('/release-evidence/ledger-before.json'));
  const unchanged = Object.entries(old.fingerprints).every(([id, value]) => fingerprints[id] === value);
  const result = { at: new Date().toISOString(), beforeCount: old.count, afterCount: rows.length, existingRowsUnchanged: unchanged, duplicateExternalEvents: duplicates };
  console.log(JSON.stringify(result));
  if (!unchanged || duplicates) process.exitCode = 1;
})().catch(() => { console.error('SAFE_LEDGER_PROOF_FAILED'); process.exitCode = 1; }).finally(() => db.$disconnect());
