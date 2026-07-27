'use strict';

const SHA256 = /^[a-f0-9]{64}$/;
const BACKUP_NAME = /^postgres-full-(\d{8}T\d{6}Z)\.sql\.gz\.enc$/;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requiredDate(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`invalid_${field}`);
  return date;
}

function requiredNonNegativeInteger(value, field) {
  if (!/^\d+$/.test(String(value))) throw new Error(`invalid_${field}`);
  return BigInt(value);
}

function safeCount(value, field) {
  const parsed = requiredNonNegativeInteger(value, field);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`invalid_${field}`);
  return Number(parsed);
}

function backupInput(args) {
  const [backupKey, startedAt, completedAt, fileSizeBytes, checksumSha256] = args;
  if (!BACKUP_NAME.test(backupKey ?? '')) throw new Error('invalid_backup_key');
  if (!SHA256.test(checksumSha256 ?? '')) throw new Error('invalid_checksum');
  const started = requiredDate(startedAt, 'started_at');
  const completed = requiredDate(completedAt, 'completed_at');
  if (completed < started || completed.getTime() > Date.now() + 300_000) throw new Error('invalid_backup_timing');
  const size = requiredNonNegativeInteger(fileSizeBytes, 'file_size');
  if (size <= 0n) throw new Error('invalid_file_size');
  return {
    backupKey,
    status: 'succeeded',
    backupType: 'full',
    startedAt: started,
    completedAt: completed,
    storageAlias: 'production-local-restricted',
    fileSizeBytes: size,
    checksumSha256,
    encrypted: true,
    encryptionAlias: 'backup-file-aes-256-gcm-v1',
    scopeSummary: {
      environment: 'production',
      source: 'postgresql-full-logical',
      compression: 'gzip-before-encryption',
    },
    safeMetadata: {
      formatVersion: 1,
      algorithm: 'aes-256-gcm',
      checksumTarget: 'ciphertext',
      fileNameTimestamp: BACKUP_NAME.exec(backupKey)[1],
    },
    failureReason: null,
    createdBy: null,
    updatedBy: null,
  };
}

function backupComparable(record) {
  return {
    backupKey: record.backupKey,
    status: record.status,
    backupType: record.backupType,
    startedAt: record.startedAt?.toISOString(),
    completedAt: record.completedAt?.toISOString(),
    storageAlias: record.storageAlias,
    fileSizeBytes: record.fileSizeBytes?.toString(),
    checksumSha256: record.checksumSha256,
    encrypted: record.encrypted,
    encryptionAlias: record.encryptionAlias,
    scopeSummary: record.scopeSummary,
    safeMetadata: record.safeMetadata,
    failureReason: record.failureReason,
  };
}

function expectedBackupComparable(input) {
  return {
    ...input,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    fileSizeBytes: input.fileSizeBytes.toString(),
    createdBy: undefined,
    updatedBy: undefined,
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function identical(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function backupAuditData(record) {
  return {
    backupKey: record.backupKey,
    status: record.status,
    backupType: record.backupType,
    startedAt: record.startedAt.toISOString(),
    completedAt: record.completedAt.toISOString(),
    storageAlias: record.storageAlias,
    fileSizeBytes: record.fileSizeBytes.toString(),
    checksumSha256: record.checksumSha256,
    encrypted: record.encrypted,
    encryptionAlias: record.encryptionAlias,
    scopeSummary: record.scopeSummary,
    safeMetadata: record.safeMetadata,
  };
}

async function reconcileBackup(prisma, input) {
  const compare = (record) => identical(backupComparable(record), expectedBackupComparable(input));
  const existing = await prisma.backupRecord.findUnique({ where: { backupKey: input.backupKey } });
  if (existing) {
    if (!compare(existing)) return { status: 'conflict', record: existing };
    return { status: 'no_change', record: existing };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const current = await tx.backupRecord.findUnique({ where: { backupKey: input.backupKey } });
        if (current) {
          if (!compare(current)) return { status: 'conflict', record: current };
          return { status: 'no_change', record: current };
        }
        const record = await tx.backupRecord.create({ data: input });
        await tx.auditLog.create({
          data: {
            actorUserId: null,
            actorRole: 'system_backup',
            action: 'backup_record.created',
            objectType: 'backup_record',
            objectId: record.id,
            beforeData: undefined,
            afterData: backupAuditData(record),
            changedFields: [
              'backupKey',
              'status',
              'backupType',
              'startedAt',
              'completedAt',
              'storageAlias',
              'fileSizeBytes',
              'checksumSha256',
              'encrypted',
              'encryptionAlias',
              'scopeSummary',
              'safeMetadata',
            ],
            requestPayload: {
              source: 'daily-backup-recorder',
              backupKey: input.backupKey,
              result: 'created',
            },
            result: 'success',
            ipAddress: null,
            userAgent: 'salary-postgres-backup/task90',
          },
        });
        return { status: 'created', record };
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (error?.code !== 'P2002' && error?.code !== 'P2034') throw error;
      const raced = await prisma.backupRecord.findUnique({ where: { backupKey: input.backupKey } });
      if (raced) {
        if (!compare(raced)) return { status: 'conflict', record: raced };
        return { status: 'no_change', record: raced };
      }
      if (attempt === 2) throw error;
    }
  }
  throw new Error('transaction_retry_exhausted');
}

function drillInput(args) {
  const [
    drillKey,
    backupKey,
    startedAt,
    completedAt,
    databaseCount,
    roleCount,
    schemaCount,
    tableCount,
    migrationCount,
    serverVersion,
  ] = args;
  if (!SAFE_KEY.test(drillKey ?? '') || !drillKey.startsWith('task90-restore-')) throw new Error('invalid_drill_key');
  if (!BACKUP_NAME.test(backupKey ?? '')) throw new Error('invalid_backup_key');
  if (!/^16(?:\.\d+|\d{4,})?$/.test(serverVersion ?? '')) throw new Error('invalid_server_version');
  const started = requiredDate(startedAt, 'started_at');
  const completed = requiredDate(completedAt, 'completed_at');
  if (completed < started || completed.getTime() > Date.now() + 300_000) throw new Error('invalid_drill_timing');
  return {
    drillKey,
    status: 'succeeded',
    environmentAlias: 'task90-isolated-postgresql16',
    backupKey,
    startedAt: started,
    completedAt: completed,
    validationSummary: {
      serverVersion,
      databaseCount: safeCount(databaseCount, 'database_count'),
      roleCount: safeCount(roleCount, 'role_count'),
      schemaCount: safeCount(schemaCount, 'schema_count'),
      tableCount: safeCount(tableCount, 'table_count'),
      migrationCount: safeCount(migrationCount, 'migration_count'),
      checksum: 'match',
      decryptAuthentication: 'pass',
      gzipIntegrity: 'pass',
      restore: 'pass',
    },
    safeMetadata: {
      networkMode: 'none',
      hostPortBindings: 0,
      destructiveToPrimary: false,
      productionDatabaseContacted: false,
      cleanup: 'complete',
    },
    failureReason: null,
    createdBy: null,
    updatedBy: null,
  };
}

function drillComparable(record) {
  return {
    drillKey: record.drillKey,
    status: record.status,
    environmentAlias: record.environmentAlias,
    backupKey: record.backupKey,
    startedAt: record.startedAt?.toISOString(),
    completedAt: record.completedAt?.toISOString(),
    validationSummary: record.validationSummary,
    safeMetadata: record.safeMetadata,
    failureReason: record.failureReason,
  };
}

function expectedDrillComparable(input) {
  return {
    ...input,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    createdBy: undefined,
    updatedBy: undefined,
  };
}

async function reconcileDrill(prisma, input) {
  const compare = (record) => identical(drillComparable(record), expectedDrillComparable(input));
  const existing = await prisma.restoreDrillRecord.findUnique({ where: { drillKey: input.drillKey } });
  if (existing) return { status: compare(existing) ? 'no_change' : 'conflict', record: existing };
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.restoreDrillRecord.findUnique({ where: { drillKey: input.drillKey } });
      if (current) return { status: compare(current) ? 'no_change' : 'conflict', record: current };
      const record = await tx.restoreDrillRecord.create({ data: input });
      await tx.auditLog.create({
        data: {
          actorUserId: null,
          actorRole: 'system_backup',
          action: 'restore_drill.created',
          objectType: 'restore_drill',
          objectId: record.id,
          beforeData: undefined,
          afterData: {
            drillKey: record.drillKey,
            status: record.status,
            environmentAlias: record.environmentAlias,
            backupKey: record.backupKey,
            startedAt: record.startedAt.toISOString(),
            completedAt: record.completedAt.toISOString(),
            validationSummary: record.validationSummary,
            safeMetadata: record.safeMetadata,
          },
          changedFields: [
            'drillKey',
            'status',
            'environmentAlias',
            'backupKey',
            'startedAt',
            'completedAt',
            'validationSummary',
            'safeMetadata',
          ],
          requestPayload: {
            source: 'task90-isolated-restore',
            drillKey: input.drillKey,
            result: 'created',
          },
          result: 'success',
          ipAddress: null,
          userAgent: 'salary-postgres-backup/task90',
        },
      });
      return { status: 'created', record };
    }, { isolationLevel: 'Serializable' });
  } catch (error) {
    if (error?.code !== 'P2002' && error?.code !== 'P2034') throw error;
    const raced = await prisma.restoreDrillRecord.findUnique({ where: { drillKey: input.drillKey } });
    if (!raced) throw error;
    return { status: compare(raced) ? 'no_change' : 'conflict', record: raced };
  }
}

function safeRecordId(id) {
  return UUID.test(id ?? '') ? id : 'unavailable';
}

async function main() {
  const offset = process.argv[1] === '-' ? 2 : 2;
  const [command, ...args] = process.argv.slice(offset);
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const beforeCount = command === 'backup'
      ? await prisma.backupRecord.count()
      : await prisma.restoreDrillRecord.count();
    const result = command === 'backup'
      ? await reconcileBackup(prisma, backupInput(args))
      : command === 'drill'
        ? await reconcileDrill(prisma, drillInput(args))
        : (() => { throw new Error('invalid_command'); })();
    const afterCount = command === 'backup'
      ? await prisma.backupRecord.count()
      : await prisma.restoreDrillRecord.count();
    console.log(`EVIDENCE_TYPE=${command}`);
    console.log(`EVIDENCE_SYNC_STATUS=${result.status}`);
    console.log(`EVIDENCE_RECORD_ID=${safeRecordId(result.record.id)}`);
    console.log(`EVIDENCE_RECORD_COUNT_BEFORE=${beforeCount}`);
    console.log(`EVIDENCE_RECORD_COUNT_AFTER=${afterCount}`);
    if (result.status === 'conflict') process.exitCode = 3;
  } finally {
    await prisma.$disconnect();
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : '';
  return /^invalid_[a-z_]+$/.test(message) || message === 'transaction_retry_exhausted'
    ? message
    : 'operation_failed';
}

if (require.main === module || process.argv[1] === '-') {
  main().catch((error) => {
    console.error(`EVIDENCE_SYNC_ERROR=${safeError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  backupInput,
  drillInput,
  reconcileBackup,
  reconcileDrill,
};
