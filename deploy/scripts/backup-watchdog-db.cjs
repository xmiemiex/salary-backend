'use strict';

const SOURCE = 'backup_watchdog';
const SYNTHETIC_SOURCE = 'backup_watchdog_synthetic';
const KEY_SYNTHETIC_SOURCE = 'backup_watchdog_key_recovery_synthetic';
const ACTOR_ROLE = 'system_backup_watchdog';
const USER_AGENT = 'salary-backup-watchdog/task94';
const STALE_SECONDS = 36 * 60 * 60;
const DISK_WARNING_PERCENT = 80;
const DISK_CRITICAL_PERCENT = 90;
const MIN_AVAILABLE_BYTES = 5 * 1024 * 1024 * 1024;
const BACKUP_NAME = /^postgres-full-\d{8}T\d{6}Z\.sql\.gz\.enc$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_REASON = /^[a-z0-9_:-]{1,64}$/;
const ACTIVE_STATUSES = ['active', 'silenced'];

const DEFINITIONS = Object.freeze({
  BACKUP_TIMER_INACTIVE: {
    severity: 'critical',
    title: 'Backup timer is inactive',
    message: 'The daily backup timer is missing, disabled, or inactive.',
  },
  BACKUP_SERVICE_FAILED: {
    severity: 'critical',
    title: 'Backup service failed',
    message: 'The latest daily backup service result is not success/0.',
  },
  BACKUP_STALE_OVER_36H: {
    severity: 'critical',
    title: 'Successful full backup is stale',
    message: 'No current successful full backup is available within 36 hours.',
  },
  BACKUP_FILE_MISSING: {
    severity: 'critical',
    title: 'Physical backup file is missing',
    message: 'The latest encrypted physical full backup could not be found.',
  },
  BACKUP_CHECKSUM_INVALID: {
    severity: 'critical',
    title: 'Backup checksum is invalid',
    message: 'The latest encrypted backup checksum sidecar is missing or does not match.',
  },
  BACKUP_RECORD_MISSING: {
    severity: 'critical',
    title: 'BackupRecord is missing',
    message: 'The latest physical backup has no matching BackupRecord.',
  },
  BACKUP_RECORD_MISMATCH: {
    severity: 'critical',
    title: 'BackupRecord does not match',
    message: 'The latest physical backup and BackupRecord metadata are inconsistent.',
  },
  BACKUP_HEALTH_CRITICAL: {
    severity: 'critical',
    title: 'Backup health is critical',
    message: 'The supported local backup health check reported a critical failure.',
  },
  BACKUP_DISK_WARNING: {
    severity: 'warning',
    title: 'Backup disk usage warning',
    message: 'Backup filesystem usage is at or above 80 percent.',
  },
  BACKUP_DISK_CRITICAL: {
    severity: 'critical',
    title: 'Backup disk capacity is critical',
    message: 'Backup filesystem usage is at or above 90 percent or available space is below 5 GiB.',
  },
  BACKUP_WATCHDOG_FAILED: {
    severity: 'critical',
    title: 'Backup watchdog failed',
    message: 'The independent backup watchdog could not complete its checks.',
  },
  BACKUP_ACTIVE_KEY_MISSING: {
    severity: 'critical',
    title: 'Active backup encryption key is missing',
    message: 'The configured active backup encryption key is missing.',
  },
  BACKUP_ACTIVE_KEY_PERMISSION_INVALID: {
    severity: 'critical',
    title: 'Active backup encryption key is invalid',
    message: 'The active backup encryption key type, ownership, permissions, format, or metadata is invalid.',
  },
  BACKUP_KEY_RECOVERY_COPY_MISSING: {
    severity: 'critical',
    title: 'Backup key recovery copy is missing',
    message: 'The root-only local backup key recovery copy is missing.',
  },
  BACKUP_KEY_RECOVERY_PERMISSION_INVALID: {
    severity: 'critical',
    title: 'Backup key recovery copy is invalid',
    message: 'The recovery directory, key, or metadata type, ownership, permissions, format, or link count is invalid.',
  },
  BACKUP_KEY_RECOVERY_MISMATCH: {
    severity: 'critical',
    title: 'Backup key recovery copy does not match',
    message: 'The active and recovery key bytes, identity, or non-secret metadata do not match.',
  },
  BACKUP_KEY_RECOVERY_DECRYPT_FAILED: {
    severity: 'critical',
    title: 'Backup key recovery authentication failed',
    message: 'The recovery key could not authenticate and validate the latest encrypted backup.',
  },
});

function encodeSnapshot(args) {
  if (args.length !== 26) throw new Error('invalid_snapshot_arguments');
  const [
    checkedAt,
    timerExists,
    timerEnabled,
    timerActive,
    timerLastTriggerEpoch,
    serviceExists,
    serviceResult,
    serviceExit,
    backupExists,
    backupKey,
    backupMtimeEpoch,
    backupSizeBytes,
    checksumPresent,
    checksumValid,
    checksumSha256,
    healthStatus,
    diskUsedPercent,
    diskAvailableBytes,
    healthFailureCodes,
    activeKeyExists,
    activeKeyValid,
    recoveryKeyExists,
    recoveryKeyValid,
    keyMatch,
    recoveryDecryptStatus,
    keyHealthCodes,
  ] = args;
  const snapshot = {
    checkedAt: requiredDate(checkedAt, 'checked_at').toISOString(),
    timer: {
      exists: booleanValue(timerExists, 'timer_exists'),
      enabled: safeState(timerEnabled, 'timer_enabled'),
      active: safeState(timerActive, 'timer_active'),
      lastTriggerEpoch: optionalInteger(timerLastTriggerEpoch, 'timer_last_trigger_epoch'),
    },
    service: {
      exists: booleanValue(serviceExists, 'service_exists'),
      result: safeState(serviceResult, 'service_result'),
      exitCode: safeState(serviceExit, 'service_exit'),
    },
    backup: {
      exists: booleanValue(backupExists, 'backup_exists'),
      key: optionalBackupName(backupKey),
      mtimeEpoch: optionalInteger(backupMtimeEpoch, 'backup_mtime_epoch'),
      sizeBytes: optionalInteger(backupSizeBytes, 'backup_size_bytes'),
      checksumPresent: booleanValue(checksumPresent, 'checksum_present'),
      checksumValid: booleanValue(checksumValid, 'checksum_valid'),
      checksumSha256: optionalSha256(checksumSha256),
    },
    health: {
      status: enumValue(healthStatus, ['pass', 'warning', 'fail'], 'health_status'),
      failureCodes: safeCodeList(healthFailureCodes),
    },
    disk: {
      usedPercent: requiredInteger(diskUsedPercent, 0, 100, 'disk_used_percent'),
      availableBytes: requiredInteger(diskAvailableBytes, 0, Number.MAX_SAFE_INTEGER, 'disk_available_bytes'),
    },
    keyRecovery: {
      activeExists: booleanValue(activeKeyExists, 'active_key_exists'),
      activeValid: booleanValue(activeKeyValid, 'active_key_valid'),
      recoveryExists: booleanValue(recoveryKeyExists, 'recovery_key_exists'),
      recoveryValid: booleanValue(recoveryKeyValid, 'recovery_key_valid'),
      matches: enumValue(keyMatch, ['true', 'false', 'unknown'], 'key_match'),
      decryptStatus: enumValue(
        recoveryDecryptStatus,
        ['pass', 'fail', 'not_checked'],
        'recovery_decrypt_status',
      ),
      healthCodes: safeCodeList(keyHealthCodes),
    },
  };
  validateSnapshot(snapshot);
  return Buffer.from(JSON.stringify(snapshot)).toString('base64url');
}

function decodeSnapshot(encoded) {
  if (typeof encoded !== 'string' || encoded.length < 8 || encoded.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('invalid_snapshot_encoding');
  }
  let snapshot;
  try {
    snapshot = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid_snapshot_encoding');
  }
  return validateSnapshot(snapshot);
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('invalid_snapshot');
  requiredDate(snapshot.checkedAt, 'checked_at');
  if (!snapshot.timer || !snapshot.service || !snapshot.backup || !snapshot.health
    || !snapshot.disk || !snapshot.keyRecovery) {
    throw new Error('invalid_snapshot');
  }
  booleanValue(snapshot.timer.exists, 'timer_exists');
  safeState(snapshot.timer.enabled, 'timer_enabled');
  safeState(snapshot.timer.active, 'timer_active');
  optionalInteger(snapshot.timer.lastTriggerEpoch, 'timer_last_trigger_epoch');
  booleanValue(snapshot.service.exists, 'service_exists');
  safeState(snapshot.service.result, 'service_result');
  safeState(snapshot.service.exitCode, 'service_exit');
  booleanValue(snapshot.backup.exists, 'backup_exists');
  optionalBackupName(snapshot.backup.key);
  optionalInteger(snapshot.backup.mtimeEpoch, 'backup_mtime_epoch');
  optionalInteger(snapshot.backup.sizeBytes, 'backup_size_bytes');
  booleanValue(snapshot.backup.checksumPresent, 'checksum_present');
  booleanValue(snapshot.backup.checksumValid, 'checksum_valid');
  optionalSha256(snapshot.backup.checksumSha256);
  enumValue(snapshot.health.status, ['pass', 'warning', 'fail'], 'health_status');
  safeCodeList(snapshot.health.failureCodes);
  requiredInteger(snapshot.disk.usedPercent, 0, 100, 'disk_used_percent');
  requiredInteger(snapshot.disk.availableBytes, 0, Number.MAX_SAFE_INTEGER, 'disk_available_bytes');
  booleanValue(snapshot.keyRecovery.activeExists, 'active_key_exists');
  booleanValue(snapshot.keyRecovery.activeValid, 'active_key_valid');
  booleanValue(snapshot.keyRecovery.recoveryExists, 'recovery_key_exists');
  booleanValue(snapshot.keyRecovery.recoveryValid, 'recovery_key_valid');
  enumValue(snapshot.keyRecovery.matches, ['true', 'false', 'unknown'], 'key_match');
  enumValue(
    snapshot.keyRecovery.decryptStatus,
    ['pass', 'fail', 'not_checked'],
    'recovery_decrypt_status',
  );
  safeCodeList(snapshot.keyRecovery.healthCodes);
  if (snapshot.backup.exists) {
    if (!BACKUP_NAME.test(snapshot.backup.key ?? '')
      || !Number.isSafeInteger(snapshot.backup.mtimeEpoch)
      || !Number.isSafeInteger(snapshot.backup.sizeBytes)
      || snapshot.backup.sizeBytes <= 0) {
      throw new Error('invalid_backup_snapshot');
    }
  }
  return snapshot;
}

function evaluateSnapshot(snapshot, records, now = new Date(snapshot.checkedAt)) {
  validateSnapshot(snapshot);
  if (!records || typeof records !== 'object') throw new Error('invalid_records');
  const candidates = [];
  const add = (code, details = {}) => candidates.push(candidate(code, details));

  const timerLastTriggerAgeSeconds = snapshot.timer.lastTriggerEpoch === null
    ? null
    : Math.max(0, Math.floor(now.getTime() / 1000) - snapshot.timer.lastTriggerEpoch);
  if (!snapshot.timer.exists
    || snapshot.timer.enabled !== 'enabled'
    || snapshot.timer.active !== 'active'
    || timerLastTriggerAgeSeconds === null
    || timerLastTriggerAgeSeconds >= STALE_SECONDS) {
    add('BACKUP_TIMER_INACTIVE', {
      timerExists: snapshot.timer.exists,
      timerEnabled: snapshot.timer.enabled,
      timerActive: snapshot.timer.active,
      timerLastTriggerAgeSeconds,
      timerLastTriggerThresholdSeconds: STALE_SECONDS,
    });
  }
  if (!snapshot.service.exists || snapshot.service.result !== 'success' || snapshot.service.exitCode !== '0') {
    add('BACKUP_SERVICE_FAILED', {
      serviceExists: snapshot.service.exists,
      serviceResult: snapshot.service.result,
      serviceExitCode: snapshot.service.exitCode,
    });
  }

  const physicalAgeSeconds = snapshot.backup.exists
    ? Math.max(0, Math.floor(now.getTime() / 1000) - snapshot.backup.mtimeEpoch)
    : null;
  const recordAt = records.latestSuccessful?.completedAt ?? records.latestSuccessful?.startedAt ?? null;
  const recordAgeSeconds = recordAt
    ? Math.max(0, Math.floor((now.getTime() - new Date(recordAt).getTime()) / 1000))
    : null;
  if (!snapshot.backup.exists
    || physicalAgeSeconds === null
    || physicalAgeSeconds >= STALE_SECONDS
    || recordAgeSeconds === null
    || recordAgeSeconds >= STALE_SECONDS) {
    add('BACKUP_STALE_OVER_36H', {
      physicalAgeSeconds,
      recordAgeSeconds,
      thresholdSeconds: STALE_SECONDS,
    });
  }

  if (!snapshot.backup.exists) {
    add('BACKUP_FILE_MISSING');
  } else {
    if (!snapshot.backup.checksumPresent || !snapshot.backup.checksumValid || !snapshot.backup.checksumSha256) {
      add('BACKUP_CHECKSUM_INVALID', {
        checksumPresent: snapshot.backup.checksumPresent,
        checksumValid: snapshot.backup.checksumValid,
      });
    }
    if (!records.matching) {
      add('BACKUP_RECORD_MISSING', { backupKey: snapshot.backup.key });
    } else if (!recordMatches(snapshot.backup, records.matching)) {
      add('BACKUP_RECORD_MISMATCH', {
        backupKey: snapshot.backup.key,
        status: records.matching.status,
        backupType: records.matching.backupType,
        encrypted: records.matching.encrypted,
        checksumMatches: records.matching.checksumSha256 === snapshot.backup.checksumSha256,
        sizeMatches: String(records.matching.fileSizeBytes) === String(snapshot.backup.sizeBytes),
      });
    }
  }

  const databaseHealthFailureCodes = backupHealthCriticalCodes(records, now);
  if (snapshot.health.status === 'fail' || databaseHealthFailureCodes.length > 0) {
    add('BACKUP_HEALTH_CRITICAL', {
      failureCodes: snapshot.health.failureCodes,
      databaseHealthFailureCodes,
    });
  }

  if (snapshot.disk.usedPercent >= DISK_CRITICAL_PERCENT
    || snapshot.disk.availableBytes < MIN_AVAILABLE_BYTES) {
    add('BACKUP_DISK_CRITICAL', {
      usedPercent: snapshot.disk.usedPercent,
      availableBytes: snapshot.disk.availableBytes,
      criticalPercent: DISK_CRITICAL_PERCENT,
      minimumAvailableBytes: MIN_AVAILABLE_BYTES,
    });
  } else if (snapshot.disk.usedPercent >= DISK_WARNING_PERCENT) {
    add('BACKUP_DISK_WARNING', {
      usedPercent: snapshot.disk.usedPercent,
      warningPercent: DISK_WARNING_PERCENT,
    });
  }

  const keyDetails = { failureCodes: snapshot.keyRecovery.healthCodes };
  if (!snapshot.keyRecovery.activeExists) {
    add('BACKUP_ACTIVE_KEY_MISSING', keyDetails);
  } else if (!snapshot.keyRecovery.activeValid) {
    add('BACKUP_ACTIVE_KEY_PERMISSION_INVALID', keyDetails);
  }
  if (!snapshot.keyRecovery.recoveryExists) {
    add('BACKUP_KEY_RECOVERY_COPY_MISSING', keyDetails);
  } else if (!snapshot.keyRecovery.recoveryValid) {
    add('BACKUP_KEY_RECOVERY_PERMISSION_INVALID', keyDetails);
  }
  if (snapshot.keyRecovery.matches === 'false') {
    add('BACKUP_KEY_RECOVERY_MISMATCH', keyDetails);
  }
  if (snapshot.keyRecovery.decryptStatus === 'fail') {
    add('BACKUP_KEY_RECOVERY_DECRYPT_FAILED', keyDetails);
  }

  return dedupeCandidates(candidates);
}

function recordMatches(backup, record) {
  return record.backupKey === backup.key
    && record.status === 'succeeded'
    && record.backupType === 'full'
    && record.encrypted === true
    && record.encryptionAlias === 'backup-file-aes-256-gcm-v1'
    && record.checksumSha256 === backup.checksumSha256
    && String(record.fileSizeBytes) === String(backup.sizeBytes);
}

function backupHealthCriticalCodes(records, now) {
  const codes = [];
  if (!records.latestSuccessful) {
    codes.push('no_successful_full_backup');
  } else {
    const completedAt = records.latestSuccessful.completedAt ?? records.latestSuccessful.startedAt;
    const ageMs = now.getTime() - new Date(completedAt).getTime();
    if (ageMs > 3 * 24 * 60 * 60 * 1000) codes.push('successful_full_backup_older_than_72h');
    if (records.latestSuccessful.encrypted !== true) codes.push('successful_full_backup_not_encrypted');
  }
  if (records.latestBackup?.status === 'failed') codes.push('latest_backup_record_failed');
  if (records.latestSuccessfulRestore) {
    const completedAt = records.latestSuccessfulRestore.completedAt ?? records.latestSuccessfulRestore.startedAt;
    const ageMs = now.getTime() - new Date(completedAt).getTime();
    if (ageMs > 90 * 24 * 60 * 60 * 1000) codes.push('successful_restore_drill_older_than_90d');
  }
  return codes;
}

function candidate(code, details = {}, overrides = {}) {
  const definition = DEFINITIONS[code];
  if (!definition) throw new Error('invalid_alert_code');
  return {
    fingerprint: `${overrides.source ?? SOURCE}:${code}`,
    severity: overrides.severity ?? definition.severity,
    source: overrides.source ?? SOURCE,
    category: overrides.category ?? code.toLowerCase(),
    title: overrides.title ?? definition.title,
    safeMessage: overrides.safeMessage ?? definition.message,
    safeDetails: {
      code,
      synthetic: overrides.synthetic === true,
      ...details,
    },
  };
}

async function readRecords(prisma, snapshot) {
  const recordSelect = {
    backupKey: true,
    status: true,
    backupType: true,
    startedAt: true,
    completedAt: true,
    fileSizeBytes: true,
    checksumSha256: true,
    encrypted: true,
    encryptionAlias: true,
  };
  const [latestSuccessful, latestBackup, latestSuccessfulRestore] = await Promise.all([
    prisma.backupRecord.findFirst({
      where: { status: 'succeeded', backupType: 'full' },
      orderBy: { completedAt: 'desc' },
      select: recordSelect,
    }),
    prisma.backupRecord.findFirst({
      orderBy: { startedAt: 'desc' },
      select: recordSelect,
    }),
    prisma.restoreDrillRecord.findFirst({
      where: { status: 'succeeded' },
      orderBy: { completedAt: 'desc' },
      select: { startedAt: true, completedAt: true },
    }),
  ]);
  const matching = snapshot.backup.exists
    ? await prisma.backupRecord.findUnique({
      where: { backupKey: snapshot.backup.key },
      select: recordSelect,
    })
    : null;
  return { latestSuccessful, latestBackup, latestSuccessfulRestore, matching };
}

async function reconcileSource(prisma, candidates, source, now = new Date(), options = {}) {
  const resolveMissing = options.resolveMissing !== false;
  const seen = new Set(candidates.map((item) => item.fingerprint));
  let generated = 0;
  let reactivated = 0;
  let updated = 0;
  let resolved = 0;
  let notificationsCreated = 0;

  await prisma.$transaction(async (tx) => {
    for (const item of candidates) {
      if (item.source !== source) throw new Error('candidate_source_mismatch');
      const existing = await tx.alert.findUnique({ where: { fingerprint: item.fingerprint } });
      const keepSilenced = existing?.status === 'silenced'
        && existing.silencedUntil
        && existing.silencedUntil > now;
      const nextStatus = keepSilenced ? 'silenced' : 'active';
      const alert = await tx.alert.upsert({
        where: { fingerprint: item.fingerprint },
        create: {
          ...item,
          status: nextStatus,
          firstSeenAt: now,
          lastSeenAt: now,
        },
        update: {
          severity: item.severity,
          status: nextStatus,
          source: item.source,
          category: item.category,
          title: item.title,
          safeMessage: item.safeMessage,
          safeDetails: item.safeDetails,
          lastSeenAt: now,
          resolvedAt: null,
          ...(keepSilenced ? {} : { silencedUntil: null }),
        },
      });
      if (!existing) {
        generated += 1;
        await writeAudit(tx, 'alert.generated', alert, now, {
          fromStatus: null,
          toStatus: alert.status,
          reason: 'watchdog_detected',
        });
        notificationsCreated += await notifyReaders(tx, alert);
      } else if (existing.status === 'resolved') {
        reactivated += 1;
        await writeAudit(tx, 'alert.generated', alert, now, {
          fromStatus: 'resolved',
          toStatus: alert.status,
          reason: 'watchdog_reactivated',
        });
        notificationsCreated += await notifyReaders(tx, alert);
      } else {
        updated += 1;
      }
    }

    if (resolveMissing) {
      const active = await tx.alert.findMany({
        where: { source, status: { in: ACTIVE_STATUSES } },
      });
      for (const alert of active) {
        if (seen.has(alert.fingerprint)) continue;
        const next = await tx.alert.update({
          where: { id: alert.id },
          data: { status: 'resolved', resolvedAt: now, lastSeenAt: now },
        });
        resolved += 1;
        await writeAudit(tx, 'alert.resolved', next, now, {
          fromStatus: alert.status,
          toStatus: 'resolved',
          reason: 'watchdog_recovered',
        });
      }
    }

    await tx.auditLog.create({
      data: {
        actorUserId: null,
        actorRole: ACTOR_ROLE,
        action: 'backup_watchdog.scan_completed',
        objectType: 'alert',
        requestPayload: {
          source,
          generated,
          reactivated,
          updated,
          resolved,
          notificationsCreated,
          candidateCount: candidates.length,
          timestamp: now.toISOString(),
        },
        result: 'success',
        ipAddress: null,
        userAgent: USER_AGENT,
      },
    });
  });

  return { generated, reactivated, updated, resolved, notificationsCreated };
}

async function notifyReaders(tx, alert) {
  const recipients = await tx.adminUser.findMany({
    where: {
      status: 'active',
      roles: {
        some: {
          role: {
            status: 'active',
            OR: [
              { code: 'super_admin' },
              { permissions: { some: { permission: { code: 'alerts.read' } } } },
            ],
          },
        },
      },
    },
    select: { id: true },
  });
  let created = 0;
  for (const recipient of recipients) {
    const existing = await tx.notification.findFirst({
      where: {
        recipientId: recipient.id,
        alertId: alert.id,
        type: 'alert.generated',
        readAt: null,
      },
      select: { id: true },
    });
    if (existing) continue;
    await tx.notification.create({
      data: {
        recipientId: recipient.id,
        alertId: alert.id,
        type: 'alert.generated',
        severity: alert.severity,
        title: alert.title,
        safeMessage: alert.safeMessage,
        safeDetails: {
          alertId: alert.id,
          fingerprint: alert.fingerprint,
          source: alert.source,
          category: alert.category,
        },
      },
    });
    created += 1;
  }
  return created;
}

async function writeAudit(tx, action, alert, now, extra) {
  await tx.auditLog.create({
    data: {
      actorUserId: null,
      actorRole: ACTOR_ROLE,
      action,
      objectType: 'alert',
      objectId: alert.id,
      requestPayload: {
        alertId: alert.id,
        fingerprint: alert.fingerprint,
        severity: alert.severity,
        source: alert.source,
        category: alert.category,
        timestamp: now.toISOString(),
        ...extra,
      },
      result: 'success',
      ipAddress: null,
      userAgent: USER_AGENT,
    },
  });
}

async function commandReconcile(prisma, encoded, dryRun) {
  const snapshot = decodeSnapshot(encoded);
  const records = await readRecords(prisma, snapshot);
  const candidates = evaluateSnapshot(snapshot, records);
  if (dryRun) {
    printResult({
      mode: 'dry_run',
      candidateCodes: candidates.map((item) => item.safeDetails.code),
      candidateCount: candidates.length,
    });
    return;
  }
  const result = await reconcileSource(prisma, candidates, SOURCE, new Date(snapshot.checkedAt));
  const activeCritical = await prisma.alert.count({
    where: { status: 'active', severity: 'critical' },
  });
  printResult({
    mode: 'reconcile',
    ...result,
    candidateCodes: candidates.map((item) => item.safeDetails.code),
    candidateCount: candidates.length,
    activeCritical,
  });
}

async function commandReportFailure(prisma, reason) {
  if (!SAFE_REASON.test(reason ?? '')) throw new Error('invalid_failure_reason');
  const now = new Date();
  const item = candidate('BACKUP_WATCHDOG_FAILED', { reason });
  const result = await reconcileSource(prisma, [item], SOURCE, now, { resolveMissing: false });
  printResult({ mode: 'report_failure', ...result, candidateCodes: ['BACKUP_WATCHDOG_FAILED'] });
}

async function commandSynthetic(prisma, action) {
  const now = new Date();
  const fingerprint = `${SYNTHETIC_SOURCE}:TASK93_SYNTHETIC_CRITICAL`;
  if (action === 'activate') {
    const item = {
      fingerprint,
      severity: 'critical',
      source: SYNTHETIC_SOURCE,
      category: 'task93_synthetic',
      title: 'Task93 synthetic backup watchdog alert',
      safeMessage: 'Synthetic task93 alert for lifecycle verification; this is not a real backup incident.',
      safeDetails: {
        code: 'TASK93_SYNTHETIC_CRITICAL',
        synthetic: true,
        task: 'task93',
      },
    };
    const result = await reconcileSource(prisma, [item], SYNTHETIC_SOURCE, now);
    const record = await prisma.alert.findUnique({ where: { fingerprint } });
    printResult({
      mode: 'synthetic_activate',
      ...result,
      alertId: record?.id ?? 'unavailable',
      status: record?.status ?? 'unavailable',
      firstSeenAt: record?.firstSeenAt?.toISOString?.() ?? 'unavailable',
      lastSeenAt: record?.lastSeenAt?.toISOString?.() ?? 'unavailable',
      activeCount: await prisma.alert.count({
        where: { fingerprint, status: { in: ACTIVE_STATUSES } },
      }),
    });
    return;
  }
  if (action === 'resolve') {
    const result = await reconcileSource(prisma, [], SYNTHETIC_SOURCE, now);
    const record = await prisma.alert.findUnique({ where: { fingerprint } });
    printResult({
      mode: 'synthetic_resolve',
      ...result,
      alertId: record?.id ?? 'unavailable',
      status: record?.status ?? 'unavailable',
      resolvedAt: record?.resolvedAt?.toISOString?.() ?? 'unavailable',
      activeCount: await prisma.alert.count({
        where: { fingerprint, status: { in: ACTIVE_STATUSES } },
      }),
    });
    return;
  }
  throw new Error('invalid_synthetic_action');
}

async function commandSyntheticKey(prisma, action) {
  const now = new Date();
  const code = 'BACKUP_KEY_RECOVERY_MISMATCH';
  const fingerprint = `${KEY_SYNTHETIC_SOURCE}:${code}`;
  if (action === 'activate') {
    const item = candidate(code, {
      synthetic: true,
      task: 'task94',
    }, {
      source: KEY_SYNTHETIC_SOURCE,
      synthetic: true,
      category: 'task94_key_recovery_synthetic',
      title: 'Task94 synthetic backup key recovery alert',
      safeMessage: 'Synthetic task94 key recovery alert for lifecycle verification; this is not a real key incident.',
    });
    const result = await reconcileSource(prisma, [item], KEY_SYNTHETIC_SOURCE, now);
    const record = await prisma.alert.findUnique({ where: { fingerprint } });
    printResult({
      mode: 'synthetic_key_activate',
      ...result,
      alertId: record?.id ?? 'unavailable',
      status: record?.status ?? 'unavailable',
      firstSeenAt: record?.firstSeenAt?.toISOString?.() ?? 'unavailable',
      lastSeenAt: record?.lastSeenAt?.toISOString?.() ?? 'unavailable',
      activeCount: await prisma.alert.count({
        where: { fingerprint, status: { in: ACTIVE_STATUSES } },
      }),
    });
    return;
  }
  if (action === 'resolve') {
    const result = await reconcileSource(prisma, [], KEY_SYNTHETIC_SOURCE, now);
    const record = await prisma.alert.findUnique({ where: { fingerprint } });
    printResult({
      mode: 'synthetic_key_resolve',
      ...result,
      alertId: record?.id ?? 'unavailable',
      status: record?.status ?? 'unavailable',
      resolvedAt: record?.resolvedAt?.toISOString?.() ?? 'unavailable',
      activeCount: await prisma.alert.count({
        where: { fingerprint, status: { in: ACTIVE_STATUSES } },
      }),
    });
    return;
  }
  throw new Error('invalid_synthetic_action');
}

async function commandBaseline(prisma) {
  const [activeCritical, activeWatchdog, activeSynthetic, activeKeySynthetic] = await Promise.all([
    prisma.alert.count({ where: { status: 'active', severity: 'critical' } }),
    prisma.alert.count({ where: { status: { in: ACTIVE_STATUSES }, source: SOURCE } }),
    prisma.alert.count({ where: { status: { in: ACTIVE_STATUSES }, source: SYNTHETIC_SOURCE } }),
    prisma.alert.count({ where: { status: { in: ACTIVE_STATUSES }, source: KEY_SYNTHETIC_SOURCE } }),
  ]);
  printResult({
    mode: 'baseline',
    activeCritical,
    activeWatchdog,
    activeSynthetic,
    activeKeySynthetic,
  });
}

function selfTest() {
  const now = new Date('2026-07-30T12:00:00.000Z');
  const healthy = {
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
  const record = {
    backupKey: healthy.backup.key,
    status: 'succeeded',
    backupType: 'full',
    startedAt: new Date(healthy.backup.mtimeEpoch * 1000 - 60_000),
    completedAt: new Date(healthy.backup.mtimeEpoch * 1000),
    fileSizeBytes: BigInt(healthy.backup.sizeBytes),
    checksumSha256: healthy.backup.checksumSha256,
    encrypted: true,
    encryptionAlias: 'backup-file-aes-256-gcm-v1',
  };
  if (evaluateSnapshot(
    healthy,
    { latestSuccessful: record, latestBackup: record, latestSuccessfulRestore: null, matching: record },
    now,
  ).length !== 0) {
    throw new Error('self_test_healthy_failed');
  }
  const encoded = Buffer.from(JSON.stringify(healthy)).toString('base64url');
  if (decodeSnapshot(encoded).backup.key !== healthy.backup.key) throw new Error('self_test_encoding_failed');
  console.log('TASK93_BACKUP_WATCHDOG_DB_SELF_TEST=pass');
}

function printResult(result) {
  console.log(`TASK93_WATCHDOG_MODE=${result.mode}`);
  for (const key of [
    'generated',
    'reactivated',
    'updated',
    'resolved',
    'notificationsCreated',
    'candidateCount',
    'activeCritical',
    'activeWatchdog',
    'activeSynthetic',
    'activeKeySynthetic',
    'alertId',
    'status',
    'firstSeenAt',
    'lastSeenAt',
    'resolvedAt',
    'activeCount',
  ]) {
    if (result[key] !== undefined) {
      console.log(`TASK93_WATCHDOG_${camelToUpper(key)}=${String(result[key])}`);
    }
  }
  if (result.candidateCodes) {
    console.log(`TASK93_WATCHDOG_CANDIDATE_CODES=${result.candidateCodes.length ? result.candidateCodes.join(',') : 'none'}`);
  }
}

function camelToUpper(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function dedupeCandidates(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.fingerprint)) return false;
    seen.add(item.fingerprint);
    return true;
  });
}

function requiredDate(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`invalid_${field}`);
  return date;
}

function booleanValue(value, field) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`invalid_${field}`);
}

function safeState(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) throw new Error(`invalid_${field}`);
  return value;
}

function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`invalid_${field}`);
  return value;
}

function optionalBackupName(value) {
  if (value === null || value === 'none') return null;
  if (typeof value !== 'string' || !BACKUP_NAME.test(value)) throw new Error('invalid_backup_key');
  return value;
}

function optionalSha256(value) {
  if (value === null || value === 'none') return null;
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error('invalid_checksum');
  return value;
}

function optionalInteger(value, field) {
  if (value === null || value === 'none') return null;
  return requiredInteger(value, 0, Number.MAX_SAFE_INTEGER, field);
}

function requiredInteger(value, minimum, maximum, field) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) throw new Error(`invalid_${field}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`invalid_${field}`);
  return parsed;
}

function safeCodeList(value) {
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item !== 'string' || !SAFE_REASON.test(item))) throw new Error('invalid_health_codes');
    return value;
  }
  if (value === 'none' || value === '') return [];
  if (typeof value !== 'string') throw new Error('invalid_health_codes');
  const items = value.split(',');
  if (items.some((item) => !SAFE_REASON.test(item))) throw new Error('invalid_health_codes');
  return items;
}

function safeError(error) {
  const message = error instanceof Error ? error.message : '';
  return /^invalid_[a-z_]+$/.test(message) || /^self_test_[a-z_]+$/.test(message)
    ? message
    : 'operation_failed';
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'encode-snapshot') {
    console.log(encodeSnapshot(args));
    return;
  }
  if (command === 'self-test') {
    selfTest();
    return;
  }
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    if (command === 'reconcile') await commandReconcile(prisma, args[0], false);
    else if (command === 'dry-run') await commandReconcile(prisma, args[0], true);
    else if (command === 'report-failure') await commandReportFailure(prisma, args[0]);
    else if (command === 'synthetic') await commandSynthetic(prisma, args[0]);
    else if (command === 'synthetic-key') await commandSyntheticKey(prisma, args[0]);
    else if (command === 'baseline') await commandBaseline(prisma);
    else throw new Error('invalid_command');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module || process.argv[1] === '-') {
  main().catch((error) => {
    console.error(`TASK93_WATCHDOG_ERROR=${safeError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  SOURCE,
  SYNTHETIC_SOURCE,
  KEY_SYNTHETIC_SOURCE,
  DEFINITIONS,
  STALE_SECONDS,
  DISK_WARNING_PERCENT,
  DISK_CRITICAL_PERCENT,
  MIN_AVAILABLE_BYTES,
  candidate,
  decodeSnapshot,
  encodeSnapshot,
  evaluateSnapshot,
  reconcileSource,
  recordMatches,
  selfTest,
};
