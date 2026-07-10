import { BackupStatus, BackupType, Prisma, RestoreDrillStatus } from '@prisma/client';
import { BackupHealthService } from './backup-health.service';
import { BackupRecoveryService } from './backup-recovery.service';

const actor = { userId: '11111111-1111-1111-1111-111111111111', roleCode: 'super_admin', permissions: [] };
const now = new Date('2026-07-09T00:00:00.000Z');

describe('BackupRecoveryService', () => {
  it('creates and updates backup records with sanitized audit payloads', async () => {
    const prisma = prismaMock();
    const audit = auditMock();
    const service = new BackupRecoveryService(prisma as never, audit as never);

    const created = await service.createBackup(backupBody(), actor);
    expect(created.backupKey).toBe('backup-20260709-full');
    expect(prisma.backupRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ storageAlias: 'primary-offsite', encrypted: true }),
    }));

    await service.updateBackup(created.id, { status: BackupStatus.succeeded, safeMetadata: { verifiedTables: ['audit_logs', 'sync_tasks'] } }, actor);
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({
      action: 'backup_record.updated',
      changedFields: expect.arrayContaining(['status', 'safeMetadata', 'updatedBy']),
    }));
    expect(JSON.stringify(audit.success.mock.calls)).not.toMatch(/password|token|secret|DATABASE_URL|https?:\/\/|s3:\/\//i);
  });

  it('creates and updates restore drill records', async () => {
    const prisma = prismaMock();
    const service = new BackupRecoveryService(prisma as never, auditMock() as never);
    const created = await service.createDrill({
      drillKey: 'drill-20260709-ci',
      status: RestoreDrillStatus.running,
      environmentAlias: 'restore-ci',
      backupKey: 'backup-20260709-full',
      startedAt: now.toISOString(),
      validationSummary: { checks: ['admin_users', 'audit_logs'] },
      safeMetadata: { operator: 'ci' },
    }, actor);
    expect(created.drillKey).toBe('drill-20260709-ci');

    const updated = await service.updateDrill(created.id, { status: RestoreDrillStatus.succeeded, completedAt: now.toISOString() }, actor);
    expect(updated.status).toBe(RestoreDrillStatus.succeeded);
  });

  it('rejects duplicate keys, unsafe aliases, paths, urls, and secret metadata', async () => {
    const prisma = prismaMock();
    prisma.backupRecord.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }));
    const service = new BackupRecoveryService(prisma as never, auditMock() as never);
    await expect(service.createBackup(backupBody(), actor)).rejects.toThrow(/already exists/i);
    await expect(service.createBackup({ ...backupBody(), storageAlias: 's3://bucket/path' }, actor)).rejects.toThrow(/safe alias/i);
    await expect(service.createBackup({ ...backupBody(), safeMetadata: { apiKey: 'x' } }, actor)).rejects.toThrow(/unsafe/i);
    await expect(service.createDrill({ drillKey: 'drill-key', status: 'running', environmentAlias: 'restore-ci', startedAt: now.toISOString(), failureReason: 'file://backup.dump' }, actor)).rejects.toThrow(/unsafe/i);
  });
});

describe('BackupHealthService', () => {
  it('returns critical when no backup exists and warning when no drill exists', async () => {
    const health = await new BackupHealthService(prismaMock({ backups: [], drills: [] }) as never).getHealth(now);
    expect(health.status).toBe('critical');
    expect(health.checks.map((item) => item.code)).toEqual(expect.arrayContaining(['backup.no_successful_backup', 'restore_drill.none']));
  });

  it('detects old, failed, unencrypted, and checksum-missing backups plus stale drills', async () => {
    const health = await new BackupHealthService(prismaMock({
      backups: [
        { ...backupRecord, status: BackupStatus.failed, startedAt: now },
        { ...backupRecord, id: 'old', backupKey: 'old-full', status: BackupStatus.succeeded, encrypted: false, checksumSha256: null, startedAt: new Date('2026-07-01T00:00:00.000Z'), completedAt: new Date('2026-07-01T00:00:00.000Z') },
      ],
      drills: [
        { ...drillRecord, status: RestoreDrillStatus.failed, startedAt: now },
        { ...drillRecord, id: 'old-drill', drillKey: 'old-drill', status: RestoreDrillStatus.succeeded, startedAt: new Date('2026-03-01T00:00:00.000Z'), completedAt: new Date('2026-03-01T00:00:00.000Z') },
      ],
    }) as never).getHealth(now);
    expect(health.status).toBe('critical');
    expect(health.checks.map((item) => item.code)).toEqual(expect.arrayContaining([
      'backup.success_too_old',
      'backup.latest_failed',
      'backup.not_encrypted',
      'backup.checksum_missing',
      'restore_drill.too_old',
      'restore_drill.latest_failed',
    ]));
  });

  it('exposes backup alert candidates with stable fingerprints and safe details', async () => {
    const candidates = await new BackupHealthService(prismaMock({ backups: [], drills: [] }) as never).alertCandidates(now);
    expect(candidates.some((item) => item.fingerprint === 'backup-recovery:backup.no_successful_backup')).toBe(true);
    expect(JSON.stringify(candidates)).not.toMatch(/password|token|secret|DATABASE_URL|https?:\/\/|s3:\/\//i);
  });
});

function backupBody() {
  return {
    backupKey: 'backup-20260709-full',
    status: BackupStatus.running,
    backupType: BackupType.full,
    startedAt: now.toISOString(),
    storageAlias: 'primary-offsite',
    fileSizeBytes: '1024',
    checksumSha256: 'a'.repeat(64),
    encrypted: true,
    encryptionAlias: 'kms-primary',
    scopeSummary: { tables: ['admin_users', 'audit_logs', 'sync_tasks'] },
    safeMetadata: { ciRun: 'task64' },
  };
}

const backupRecord = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  backupKey: 'backup-20260709-full',
  status: BackupStatus.succeeded,
  backupType: BackupType.full,
  startedAt: now,
  completedAt: now,
  storageAlias: 'primary-offsite',
  fileSizeBytes: 1024n,
  checksumSha256: 'a'.repeat(64),
  encrypted: true,
  encryptionAlias: 'kms-primary',
  scopeSummary: {},
  safeMetadata: {},
  failureReason: null,
  createdBy: actor.userId,
  updatedBy: actor.userId,
  createdAt: now,
  updatedAt: now,
};

const drillRecord = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  drillKey: 'drill-20260709-ci',
  status: RestoreDrillStatus.succeeded,
  environmentAlias: 'restore-ci',
  backupKey: 'backup-20260709-full',
  startedAt: now,
  completedAt: now,
  validationSummary: {},
  safeMetadata: {},
  failureReason: null,
  createdBy: actor.userId,
  updatedBy: actor.userId,
  createdAt: now,
  updatedAt: now,
};

function prismaMock(options: { backups?: any[]; drills?: any[] } = {}) {
  const backups = options.backups ?? [backupRecord];
  const drills = options.drills ?? [drillRecord];
  return {
    $transaction: jest.fn(async (items: any[]) => Promise.all(items)),
    backupRecord: {
      count: jest.fn().mockResolvedValue(backups.length),
      findMany: jest.fn().mockResolvedValue(backups),
      findUnique: jest.fn().mockResolvedValue(backupRecord),
      findFirst: jest.fn((args: any) => {
        const candidates = backups.filter((item) => {
          if (!args?.where) return true;
          if (args.where.status && item.status !== args.where.status) return false;
          if (args.where.backupType && item.backupType !== args.where.backupType) return false;
          return true;
        });
        return Promise.resolve(candidates[0] ?? null);
      }),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...backupRecord, ...data, id: backupRecord.id })),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...backupRecord, ...data })),
    },
    restoreDrillRecord: {
      count: jest.fn().mockResolvedValue(drills.length),
      findMany: jest.fn().mockResolvedValue(drills),
      findUnique: jest.fn().mockResolvedValue(drillRecord),
      findFirst: jest.fn((args: any) => {
        const candidates = drills.filter((item) => !args?.where?.status || item.status === args.where.status);
        return Promise.resolve(candidates[0] ?? null);
      }),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...drillRecord, ...data, id: drillRecord.id })),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...drillRecord, ...data })),
    },
  };
}

function auditMock() {
  return {
    success: jest.fn().mockResolvedValue({}),
    failure: jest.fn().mockResolvedValue({}),
  };
}
