'use strict';

const assert = require('node:assert/strict');
const {
  SOURCE,
  KEY_SYNTHETIC_SOURCE,
  DEFINITIONS,
  DISK_WARNING_PERCENT,
  DISK_CRITICAL_PERCENT,
  MIN_AVAILABLE_BYTES,
  evaluateSnapshot,
  candidate,
  reconcileSource,
} = require('./backup-watchdog-db.cjs');

async function main() {
  testFaultCoverageAndThresholds();
  testKeyRecoveryFaultCoverage();
  await testLifecycleIdempotencyAndIsolation();
  await testKeyAlertLifecycleIdempotency();
  testDefinitions();
  console.log('TASK93_BACKUP_WATCHDOG_DB_TESTS=pass');
}

function testKeyRecoveryFaultCoverage() {
  const now = new Date('2026-07-30T12:00:00.000Z');
  const base = healthySnapshot(now);
  const records = healthyRecords(base);
  const cases = [
    {
      code: 'BACKUP_ACTIVE_KEY_MISSING',
      mutate: (snapshot) => {
        snapshot.keyRecovery.activeExists = false;
        snapshot.keyRecovery.activeValid = false;
        snapshot.keyRecovery.matches = 'unknown';
        snapshot.keyRecovery.healthCodes = ['active_key_missing'];
      },
    },
    {
      code: 'BACKUP_ACTIVE_KEY_PERMISSION_INVALID',
      mutate: (snapshot) => {
        snapshot.keyRecovery.activeValid = false;
        snapshot.keyRecovery.matches = 'unknown';
        snapshot.keyRecovery.healthCodes = ['active_key_invalid'];
      },
    },
    {
      code: 'BACKUP_KEY_RECOVERY_COPY_MISSING',
      mutate: (snapshot) => {
        snapshot.keyRecovery.recoveryExists = false;
        snapshot.keyRecovery.recoveryValid = false;
        snapshot.keyRecovery.matches = 'unknown';
        snapshot.keyRecovery.decryptStatus = 'not_checked';
        snapshot.keyRecovery.healthCodes = ['recovery_key_missing'];
      },
    },
    {
      code: 'BACKUP_KEY_RECOVERY_PERMISSION_INVALID',
      mutate: (snapshot) => {
        snapshot.keyRecovery.recoveryValid = false;
        snapshot.keyRecovery.matches = 'unknown';
        snapshot.keyRecovery.decryptStatus = 'not_checked';
        snapshot.keyRecovery.healthCodes = ['recovery_key_invalid'];
      },
    },
    {
      code: 'BACKUP_KEY_RECOVERY_MISMATCH',
      mutate: (snapshot) => {
        snapshot.keyRecovery.matches = 'false';
        snapshot.keyRecovery.healthCodes = ['recovery_mismatch'];
      },
    },
    {
      code: 'BACKUP_KEY_RECOVERY_DECRYPT_FAILED',
      mutate: (snapshot) => {
        snapshot.keyRecovery.decryptStatus = 'fail';
        snapshot.keyRecovery.healthCodes = ['recovery_decrypt_failed'];
      },
    },
  ];

  for (const item of cases) {
    const snapshot = structuredClone(base);
    item.mutate(snapshot);
    const alerts = evaluateSnapshot(snapshot, records, now);
    assert.deepEqual(alerts.map((alert) => alert.safeDetails.code), [item.code]);
    assert.equal(alerts[0].severity, 'critical');
    assert.equal(alerts[0].source, SOURCE);
    assert.equal(alerts[0].fingerprint, `${SOURCE}:${item.code}`);
  }
  assert.deepEqual(evaluateSnapshot(base, records, now), []);
  assert.equal(KEY_SYNTHETIC_SOURCE, 'backup_watchdog_key_recovery_synthetic');
}

function testFaultCoverageAndThresholds() {
  const now = new Date('2026-07-30T12:00:00.000Z');
  const snapshot = healthySnapshot(now);
  const matching = matchingRecord(snapshot);
  assert.deepEqual(evaluateSnapshot(
    snapshot,
    { latestSuccessful: matching, latestBackup: matching, latestSuccessfulRestore: null, matching },
    now,
  ), []);

  const broken = structuredClone(snapshot);
  Object.assign(broken.timer, { exists: false, enabled: 'disabled', active: 'inactive' });
  Object.assign(broken.service, { exists: false, result: 'failed', exitCode: '1' });
  Object.assign(broken.backup, {
    mtimeEpoch: Math.floor(now.getTime() / 1000) - (36 * 60 * 60),
    checksumPresent: false,
    checksumValid: false,
    checksumSha256: null,
  });
  Object.assign(broken.health, { status: 'fail', failureCodes: ['checksum_mismatch'] });
  Object.assign(broken.disk, { usedPercent: 90, availableBytes: MIN_AVAILABLE_BYTES - 1 });
  const codes = evaluateSnapshot(
    broken,
    { latestSuccessful: null, latestBackup: null, latestSuccessfulRestore: null, matching: null },
    now,
  )
    .map((item) => item.safeDetails.code);
  assert.deepEqual(codes, [
    'BACKUP_TIMER_INACTIVE',
    'BACKUP_SERVICE_FAILED',
    'BACKUP_STALE_OVER_36H',
    'BACKUP_CHECKSUM_INVALID',
    'BACKUP_RECORD_MISSING',
    'BACKUP_HEALTH_CRITICAL',
    'BACKUP_DISK_CRITICAL',
  ]);

  const mismatch = { ...matching, checksumSha256: 'b'.repeat(64) };
  assert.ok(evaluateSnapshot(
    snapshot,
    { latestSuccessful: matching, latestBackup: matching, latestSuccessfulRestore: null, matching: mismatch },
    now,
  )
    .some((item) => item.safeDetails.code === 'BACKUP_RECORD_MISMATCH'));

  const missing = structuredClone(snapshot);
  Object.assign(missing.backup, {
    exists: false,
    key: null,
    mtimeEpoch: null,
    sizeBytes: null,
    checksumPresent: false,
    checksumValid: false,
    checksumSha256: null,
  });
  const missingCodes = evaluateSnapshot(
    missing,
    { latestSuccessful: matching, latestBackup: matching, latestSuccessfulRestore: null, matching: null },
    now,
  )
    .map((item) => item.safeDetails.code);
  assert.ok(missingCodes.includes('BACKUP_FILE_MISSING'));

  const warning = healthySnapshot(now);
  warning.disk.usedPercent = DISK_WARNING_PERCENT;
  assert.deepEqual(
    evaluateSnapshot(
      warning,
      {
        latestSuccessful: matchingRecord(warning),
        latestBackup: matchingRecord(warning),
        latestSuccessfulRestore: null,
        matching: matchingRecord(warning),
      },
      now,
    )
      .map((item) => item.safeDetails.code),
    ['BACKUP_DISK_WARNING'],
  );

  const belowWarning = healthySnapshot(now);
  belowWarning.disk.usedPercent = DISK_WARNING_PERCENT - 1;
  assert.equal(evaluateSnapshot(
    belowWarning,
    {
      latestSuccessful: matchingRecord(belowWarning),
      latestBackup: matchingRecord(belowWarning),
      latestSuccessfulRestore: null,
      matching: matchingRecord(belowWarning),
    },
    now,
  ).length, 0);

  const critical = healthySnapshot(now);
  critical.disk.usedPercent = DISK_CRITICAL_PERCENT;
  assert.deepEqual(
    evaluateSnapshot(
      critical,
      {
        latestSuccessful: matchingRecord(critical),
        latestBackup: matchingRecord(critical),
        latestSuccessfulRestore: null,
        matching: matchingRecord(critical),
      },
      now,
    )
      .map((item) => item.safeDetails.code),
    ['BACKUP_DISK_CRITICAL'],
  );

  const lowSpace = healthySnapshot(now);
  lowSpace.disk.availableBytes = MIN_AVAILABLE_BYTES - 1;
  assert.deepEqual(
    evaluateSnapshot(
      lowSpace,
      {
        latestSuccessful: matchingRecord(lowSpace),
        latestBackup: matchingRecord(lowSpace),
        latestSuccessfulRestore: null,
        matching: matchingRecord(lowSpace),
      },
      now,
    )
      .map((item) => item.safeDetails.code),
    ['BACKUP_DISK_CRITICAL'],
  );
}

async function testLifecycleIdempotencyAndIsolation() {
  const prisma = memoryPrisma();
  const unrelated = await prisma.alert.upsert({
    where: { fingerprint: 'system-health:UNRELATED' },
    create: alertData('system-health:UNRELATED', 'system_health'),
    update: {},
  });
  const firstAt = new Date('2026-07-30T12:00:00.000Z');
  const secondAt = new Date('2026-07-30T12:05:00.000Z');
  const recoveredAt = new Date('2026-07-30T12:10:00.000Z');
  const item = {
    fingerprint: `${SOURCE}:BACKUP_TIMER_INACTIVE`,
    severity: 'critical',
    source: SOURCE,
    category: 'backup_timer_inactive',
    title: 'Backup timer is inactive',
    safeMessage: 'The timer is inactive.',
    safeDetails: { code: 'BACKUP_TIMER_INACTIVE', synthetic: false },
  };

  const first = await reconcileSource(prisma, [item], SOURCE, firstAt);
  assert.deepEqual(
    pick(first, ['generated', 'reactivated', 'updated', 'resolved']),
    { generated: 1, reactivated: 0, updated: 0, resolved: 0 },
  );
  const created = await prisma.alert.findUnique({ where: { fingerprint: item.fingerprint } });

  const repeated = await reconcileSource(prisma, [item], SOURCE, secondAt);
  assert.deepEqual(
    pick(repeated, ['generated', 'reactivated', 'updated', 'resolved']),
    { generated: 0, reactivated: 0, updated: 1, resolved: 0 },
  );
  const updated = await prisma.alert.findUnique({ where: { fingerprint: item.fingerprint } });
  assert.equal(updated.id, created.id);
  assert.equal(updated.firstSeenAt.toISOString(), firstAt.toISOString());
  assert.equal(updated.lastSeenAt.toISOString(), secondAt.toISOString());
  assert.equal(await prisma.alert.count({ where: { source: SOURCE, status: 'active' } }), 1);

  const recovered = await reconcileSource(prisma, [], SOURCE, recoveredAt);
  assert.equal(recovered.resolved, 1);
  const resolved = await prisma.alert.findUnique({ where: { fingerprint: item.fingerprint } });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolvedAt.toISOString(), recoveredAt.toISOString());
  assert.equal((await prisma.alert.findUnique({ where: { id: unrelated.id } })).status, 'active');

  const reactivatedAt = new Date('2026-07-30T12:15:00.000Z');
  const reactivated = await reconcileSource(prisma, [item], SOURCE, reactivatedAt);
  assert.equal(reactivated.reactivated, 1);
  const activeAgain = await prisma.alert.findUnique({ where: { fingerprint: item.fingerprint } });
  assert.equal(activeAgain.id, created.id);
  assert.equal(activeAgain.firstSeenAt.toISOString(), firstAt.toISOString());
  assert.equal(activeAgain.resolvedAt, null);
  assert.equal(prisma.state.alerts.length, 2);
  assert.ok(prisma.state.audits.some((entry) => entry.action === 'alert.resolved'));
}

async function testKeyAlertLifecycleIdempotency() {
  const prisma = memoryPrisma();
  const firstAt = new Date('2026-07-30T13:00:00.000Z');
  const repeatedAt = new Date('2026-07-30T13:05:00.000Z');
  const recoveredAt = new Date('2026-07-30T13:10:00.000Z');
  const item = candidate('BACKUP_KEY_RECOVERY_MISMATCH', { failureCodes: ['recovery_mismatch'] });

  const first = await reconcileSource(prisma, [item], SOURCE, firstAt);
  assert.deepEqual(
    pick(first, ['generated', 'updated', 'resolved', 'notificationsCreated']),
    { generated: 1, updated: 0, resolved: 0, notificationsCreated: 1 },
  );
  const created = await prisma.alert.findUnique({ where: { fingerprint: item.fingerprint } });

  const repeated = await reconcileSource(prisma, [item], SOURCE, repeatedAt);
  assert.deepEqual(
    pick(repeated, ['generated', 'updated', 'resolved', 'notificationsCreated']),
    { generated: 0, updated: 1, resolved: 0, notificationsCreated: 0 },
  );
  const updated = await prisma.alert.findUnique({ where: { fingerprint: item.fingerprint } });
  assert.equal(updated.id, created.id);
  assert.equal(await prisma.alert.count({ where: { fingerprint: item.fingerprint, status: 'active' } }), 1);

  const recovered = await reconcileSource(prisma, [], SOURCE, recoveredAt);
  assert.equal(recovered.resolved, 1);
  const resolved = await prisma.alert.findUnique({ where: { fingerprint: item.fingerprint } });
  assert.equal(resolved.status, 'resolved');
  assert.equal(await prisma.alert.count({ where: { fingerprint: item.fingerprint, status: 'active' } }), 0);
}

function testDefinitions() {
  assert.deepEqual(Object.keys(DEFINITIONS), [
    'BACKUP_TIMER_INACTIVE',
    'BACKUP_SERVICE_FAILED',
    'BACKUP_STALE_OVER_36H',
    'BACKUP_FILE_MISSING',
    'BACKUP_CHECKSUM_INVALID',
    'BACKUP_RECORD_MISSING',
    'BACKUP_RECORD_MISMATCH',
    'BACKUP_HEALTH_CRITICAL',
    'BACKUP_DISK_WARNING',
    'BACKUP_DISK_CRITICAL',
    'BACKUP_WATCHDOG_FAILED',
    'BACKUP_ACTIVE_KEY_MISSING',
    'BACKUP_ACTIVE_KEY_PERMISSION_INVALID',
    'BACKUP_KEY_RECOVERY_COPY_MISSING',
    'BACKUP_KEY_RECOVERY_PERMISSION_INVALID',
    'BACKUP_KEY_RECOVERY_MISMATCH',
    'BACKUP_KEY_RECOVERY_DECRYPT_FAILED',
  ]);
}

function healthySnapshot(now) {
  return {
    checkedAt: now.toISOString(),
    timer: {
      exists: true,
      enabled: 'enabled',
      active: 'active',
      lastTriggerEpoch: Math.floor(now.getTime() / 1000) - 3600,
    },
    service: { exists: true, result: 'success', exitCode: '0' },
    backup: {
      exists: true,
      key: 'postgres-full-20260730T020000Z.sql.gz.enc',
      mtimeEpoch: Math.floor(now.getTime() / 1000) - 3600,
      sizeBytes: 1024,
      checksumPresent: true,
      checksumValid: true,
      checksumSha256: 'a'.repeat(64),
    },
    health: { status: 'pass', failureCodes: [] },
    disk: { usedPercent: 4, availableBytes: 100 * 1024 * 1024 * 1024 },
    keyRecovery: {
      activeExists: true,
      activeValid: true,
      recoveryExists: true,
      recoveryValid: true,
      matches: 'true',
      decryptStatus: 'pass',
      healthCodes: [],
    },
  };
}

function healthyRecords(snapshot) {
  const matching = matchingRecord(snapshot);
  return {
    latestSuccessful: matching,
    latestBackup: matching,
    latestSuccessfulRestore: null,
    matching,
  };
}

function matchingRecord(snapshot) {
  return {
    backupKey: snapshot.backup.key,
    status: 'succeeded',
    backupType: 'full',
    startedAt: new Date((snapshot.backup.mtimeEpoch - 60) * 1000),
    completedAt: new Date(snapshot.backup.mtimeEpoch * 1000),
    fileSizeBytes: BigInt(snapshot.backup.sizeBytes),
    checksumSha256: snapshot.backup.checksumSha256,
    encrypted: true,
    encryptionAlias: 'backup-file-aes-256-gcm-v1',
  };
}

function memoryPrisma() {
  const state = {
    alerts: [],
    notifications: [],
    audits: [],
    recipients: [{ id: '11111111-1111-1111-1111-111111111111' }],
    nextId: 1,
  };
  const prisma = {
    state,
    $transaction: async (callback) => callback(prisma),
    alert: {
      findUnique: async ({ where }) => clone(state.alerts.find((item) =>
        (where.fingerprint && item.fingerprint === where.fingerprint)
        || (where.id && item.id === where.id)) ?? null),
      upsert: async ({ where, create, update }) => {
        const existing = state.alerts.find((item) => item.fingerprint === where.fingerprint);
        if (existing) {
          Object.assign(existing, clone(update), { updatedAt: new Date() });
          return clone(existing);
        }
        const created = {
          id: `00000000-0000-0000-0000-${String(state.nextId++).padStart(12, '0')}`,
          resolvedAt: null,
          silencedUntil: null,
          ...clone(create),
        };
        state.alerts.push(created);
        return clone(created);
      },
      findMany: async ({ where }) => state.alerts.filter((item) => matchesWhere(item, where)).map(clone),
      update: async ({ where, data }) => {
        const item = state.alerts.find((entry) => entry.id === where.id);
        assert.ok(item);
        Object.assign(item, clone(data));
        return clone(item);
      },
      count: async ({ where }) => state.alerts.filter((item) => matchesWhere(item, where)).length,
    },
    adminUser: {
      findMany: async () => clone(state.recipients),
    },
    notification: {
      findFirst: async ({ where }) => clone(state.notifications.find((item) => matchesWhere(item, where)) ?? null),
      create: async ({ data }) => {
        const item = { id: `notification-${state.nextId++}`, readAt: null, ...clone(data) };
        state.notifications.push(item);
        return clone(item);
      },
    },
    auditLog: {
      create: async ({ data }) => {
        state.audits.push(clone(data));
        return clone(data);
      },
    },
  };
  return prisma;
}

function matchesWhere(item, where) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && 'in' in expected) return expected.in.includes(item[key]);
    return item[key] === expected;
  });
}

function alertData(fingerprint, source) {
  const now = new Date('2026-07-30T11:00:00.000Z');
  return {
    fingerprint,
    severity: 'warning',
    status: 'active',
    source,
    category: 'unrelated',
    title: 'Unrelated',
    safeMessage: 'Unrelated alert.',
    safeDetails: {},
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

function clone(value) {
  if (value === null || value === undefined) return value;
  return structuredClone(value);
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
