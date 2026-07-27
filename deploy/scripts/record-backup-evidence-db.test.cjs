'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  backupInput,
  drillInput,
  reconcileBackup,
  reconcileDrill,
} = require('./record-backup-evidence-db.cjs');

function backupArgs() {
  const now = new Date();
  now.setUTCMilliseconds(0);
  const completed = now.toISOString();
  const startedDate = new Date(now.getTime() - 1000);
  const stamp = startedDate.toISOString()
    .replace(/[-:]/g, '')
    .replace('.000', '');
  return [
    `postgres-full-${stamp}.sql.gz.enc`,
    startedDate.toISOString(),
    completed,
    '17786',
    'a'.repeat(64),
  ];
}

function mockPrisma() {
  const backups = new Map();
  const drills = new Map();
  const audits = [];
  let sequence = 0;
  const client = {
    backupRecord: {
      findUnique: async ({ where }) => backups.get(where.backupKey) ?? null,
      create: async ({ data }) => {
        if (backups.has(data.backupKey)) {
          const error = new Error('unique');
          error.code = 'P2002';
          throw error;
        }
        const record = { ...data, id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` };
        backups.set(data.backupKey, record);
        return record;
      },
    },
    restoreDrillRecord: {
      findUnique: async ({ where }) => drills.get(where.drillKey) ?? null,
      create: async ({ data }) => {
        const record = { ...data, id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` };
        drills.set(data.drillKey, record);
        return record;
      },
    },
    auditLog: {
      create: async ({ data }) => {
        audits.push(data);
        return data;
      },
    },
    $transaction: async (callback) => callback(client),
  };
  return { client, backups, drills, audits };
}

test('backup evidence is created once and replay is no_change without audit noise', async () => {
  const store = mockPrisma();
  const input = backupInput(backupArgs());
  const first = await reconcileBackup(store.client, input);
  const second = await reconcileBackup(store.client, input);
  assert.equal(first.status, 'created');
  assert.equal(second.status, 'no_change');
  assert.equal(store.backups.size, 1);
  assert.equal(store.audits.length, 1);
  assert.equal(store.audits[0].action, 'backup_record.created');
});

test('same backupKey with conflicting physical metadata is rejected', async () => {
  const store = mockPrisma();
  const input = backupInput(backupArgs());
  await reconcileBackup(store.client, input);
  const conflicting = { ...input, fileSizeBytes: input.fileSizeBytes + 1n };
  const result = await reconcileBackup(store.client, conflicting);
  assert.equal(result.status, 'conflict');
  assert.equal(store.backups.size, 1);
  assert.equal(store.audits.length, 1);
});

test('unencrypted names and invalid checksums cannot become successful evidence', () => {
  const args = backupArgs();
  args[0] = args[0].replace(/\.enc$/, '');
  assert.throws(() => backupInput(args), /invalid_backup_key/);
  const checksum = backupArgs();
  checksum[4] = 'not-a-checksum';
  assert.throws(() => backupInput(checksum), /invalid_checksum/);
});

test('restore drill evidence is idempotent and records only non-sensitive counts', async () => {
  const store = mockPrisma();
  const backup = backupInput(backupArgs());
  const input = drillInput([
    'task90-restore-20260727T120000Z',
    backup.backupKey,
    backup.startedAt.toISOString(),
    backup.completedAt.toISOString(),
    '2',
    '3',
    '4',
    '20',
    '17',
    '160014',
  ]);
  const first = await reconcileDrill(store.client, input);
  const second = await reconcileDrill(store.client, input);
  assert.equal(first.status, 'created');
  assert.equal(second.status, 'no_change');
  assert.equal(store.drills.size, 1);
  assert.equal(store.audits.length, 1);
  assert.deepEqual(input.safeMetadata, {
    networkMode: 'none',
    hostPortBindings: 0,
    destructiveToPrimary: false,
    productionDatabaseContacted: false,
    cleanup: 'complete',
  });
});
