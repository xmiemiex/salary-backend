'use strict';

const { createHash } = require('node:crypto');
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const root = '/app';
const output = process.argv[2] || '/app/tmp/release-evidence/migration-status.json';

async function main() {
  const startedAt = new Date();
  const migrationRoot = resolve(root, 'prisma', 'migrations');
  const expected = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      checksum: createHash('sha256')
        .update(readFileSync(resolve(migrationRoot, entry.name, 'migration.sql')))
        .digest('hex'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const applied = await prisma.$queryRawUnsafe(
    'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name',
  );
  const appliedMap = new Map(applied.map((row) => [row.migration_name, row]));
  const expectedMap = new Map(expected.map((row) => [row.name, row]));
  const pending = expected.filter((row) => !appliedMap.has(row.name)).map((row) => row.name);
  const unexpected = applied.filter((row) => !expectedMap.has(row.migration_name)).map((row) => row.migration_name);
  const incomplete = applied
    .filter((row) => !row.finished_at || row.rolled_back_at)
    .map((row) => row.migration_name);
  const checksumMismatch = expected
    .filter((row) => appliedMap.has(row.name) && appliedMap.get(row.name).checksum !== row.checksum)
    .map((row) => row.name);
  const status = pending.length === 0
    && unexpected.length === 0
    && incomplete.length === 0
    && checksumMismatch.length === 0
    ? 'pass'
    : 'fail';
  const evidence = {
    schemaVersion: 1,
    type: 'migration-status',
    command: 'read-only migration inventory and checksum comparison',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    status,
    exitCode: status === 'pass' ? 0 : 1,
    summary: {
      expectedMigrations: expected.length,
      appliedMigrations: applied.length,
      pendingMigrations: pending,
      unexpectedMigrations: unexpected,
      incompleteMigrations: incomplete,
      checksumMismatch,
      drift: unexpected.length > 0 || checksumMismatch.length > 0,
      databaseWrites: false,
    },
  };
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o640 });
  console.log(`TASK82_MIGRATION_STATUS=${status}`);
  console.log(`TASK82_MIGRATIONS_EXPECTED=${expected.length}`);
  console.log(`TASK82_MIGRATIONS_APPLIED=${applied.length}`);
  console.log(`TASK82_MIGRATIONS_PENDING=${pending.length}`);
  console.log(`TASK82_MIGRATIONS_DRIFT=${evidence.summary.drift}`);
  process.exitCode = evidence.exitCode;
}

main()
  .catch(() => {
    console.error('TASK82_MIGRATION_STATUS=fail reason=read_or_validation_error');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
