import { Injectable } from '@nestjs/common';
import { AlertSeverity, BackupStatus, BackupType, RestoreDrillStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { publicJson } from './backup-recovery-sanitizer';

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_WARNING_DAYS = 1;
const BACKUP_CRITICAL_DAYS = 3;
const DRILL_WARNING_DAYS = 30;
const DRILL_CRITICAL_DAYS = 90;

export type BackupHealthStatus = 'ok' | 'warning' | 'critical';

export type BackupHealthCheck = {
  code: string;
  status: BackupHealthStatus;
  message: string;
  safeDetails?: Record<string, unknown>;
};

@Injectable()
export class BackupHealthService {
  constructor(private readonly prisma: PrismaService) {}

  async getHealth(now = new Date()) {
    const [latestBackup, latestSuccessfulBackup, latestRestoreDrill, latestSuccessfulRestoreDrill] = await Promise.all([
      this.prisma.backupRecord.findFirst({ orderBy: { startedAt: 'desc' } }),
      this.prisma.backupRecord.findFirst({ where: { status: BackupStatus.succeeded, backupType: BackupType.full }, orderBy: { completedAt: 'desc' } }),
      this.prisma.restoreDrillRecord.findFirst({ orderBy: { startedAt: 'desc' } }),
      this.prisma.restoreDrillRecord.findFirst({ where: { status: RestoreDrillStatus.succeeded }, orderBy: { completedAt: 'desc' } }),
    ]);

    const daysSinceLastSuccessBackup = latestSuccessfulBackup ? ageDays(now, latestSuccessfulBackup.completedAt ?? latestSuccessfulBackup.startedAt) : null;
    const daysSinceLastSuccessDrill = latestSuccessfulRestoreDrill ? ageDays(now, latestSuccessfulRestoreDrill.completedAt ?? latestSuccessfulRestoreDrill.startedAt) : null;
    const checks: BackupHealthCheck[] = [];

    if (!latestBackup) checks.push(check('backup.no_successful_backup', 'critical', 'No backup record is available.'));
    if (!latestSuccessfulBackup) checks.push(check('backup.no_successful_backup', 'critical', 'No successful full backup is recorded.'));
    if (daysSinceLastSuccessBackup !== null && daysSinceLastSuccessBackup > BACKUP_CRITICAL_DAYS) {
      checks.push(check('backup.success_too_old', 'critical', 'Latest successful full backup is older than 72 hours.', { daysSinceLastSuccessBackup }));
    } else if (daysSinceLastSuccessBackup !== null && daysSinceLastSuccessBackup > BACKUP_WARNING_DAYS) {
      checks.push(check('backup.success_too_old', 'warning', 'Latest successful full backup is older than 24 hours.', { daysSinceLastSuccessBackup }));
    }
    if (latestBackup?.status === BackupStatus.failed) checks.push(check('backup.latest_failed', 'critical', 'Latest backup failed.', { backupKey: latestBackup.backupKey }));
    if (latestSuccessfulBackup && !latestSuccessfulBackup.encrypted) checks.push(check('backup.not_encrypted', 'critical', 'Latest successful backup is not encrypted.', { backupKey: latestSuccessfulBackup.backupKey }));
    if (latestSuccessfulBackup && !latestSuccessfulBackup.checksumSha256) checks.push(check('backup.checksum_missing', 'warning', 'Latest successful backup is missing checksum.', { backupKey: latestSuccessfulBackup.backupKey }));

    if (!latestRestoreDrill) checks.push(check('restore_drill.none', 'warning', 'No restore drill record is available.'));
    if (daysSinceLastSuccessDrill !== null && daysSinceLastSuccessDrill > DRILL_CRITICAL_DAYS) {
      checks.push(check('restore_drill.too_old', 'critical', 'Latest successful restore drill is older than 90 days.', { daysSinceLastSuccessDrill }));
    } else if (daysSinceLastSuccessDrill !== null && daysSinceLastSuccessDrill > DRILL_WARNING_DAYS) {
      checks.push(check('restore_drill.too_old', 'warning', 'Latest successful restore drill is older than 30 days.', { daysSinceLastSuccessDrill }));
    }
    if (latestRestoreDrill?.status === RestoreDrillStatus.failed) checks.push(check('restore_drill.latest_failed', 'warning', 'Latest restore drill failed.', { drillKey: latestRestoreDrill.drillKey }));

    return {
      latestBackup: latestBackup ? backupSummary(latestBackup) : null,
      latestSuccessfulBackup: latestSuccessfulBackup ? backupSummary(latestSuccessfulBackup) : null,
      latestRestoreDrill: latestRestoreDrill ? drillSummary(latestRestoreDrill) : null,
      latestSuccessfulRestoreDrill: latestSuccessfulRestoreDrill ? drillSummary(latestSuccessfulRestoreDrill) : null,
      daysSinceLastSuccessBackup,
      daysSinceLastSuccessDrill,
      status: aggregate(checks),
      checks,
    };
  }

  async alertCandidates(now = new Date()) {
    const health = await this.getHealth(now);
    return health.checks
      .filter((item) => item.status === 'warning' || item.status === 'critical')
      .map((item) => ({
        fingerprint: `backup-recovery:${item.code}`,
        severity: item.status === 'critical' ? AlertSeverity.critical : AlertSeverity.warning,
        source: item.code.startsWith('restore_drill.') ? 'restore_drill' : 'backup',
        category: item.code,
        title: backupAlertTitle(item.code),
        safeMessage: item.message,
        safeDetails: item.safeDetails ?? {},
      }));
  }
}

function backupSummary(record: any) {
  return {
    id: record.id,
    backupKey: record.backupKey,
    status: record.status,
    backupType: record.backupType,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    storageAlias: record.storageAlias,
    fileSizeBytes: record.fileSizeBytes?.toString?.() ?? record.fileSizeBytes ?? null,
    checksumPresent: Boolean(record.checksumSha256),
    encrypted: record.encrypted,
    encryptionAlias: record.encryptionAlias,
    scopeSummary: publicJson(record.scopeSummary),
  };
}

function drillSummary(record: any) {
  return {
    id: record.id,
    drillKey: record.drillKey,
    status: record.status,
    environmentAlias: record.environmentAlias,
    backupKey: record.backupKey,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    validationSummary: publicJson(record.validationSummary),
  };
}

function ageDays(now: Date, at: Date) {
  return Math.floor((now.getTime() - at.getTime()) / DAY_MS);
}

function check(code: string, status: BackupHealthStatus, message: string, safeDetails: Record<string, unknown> = {}): BackupHealthCheck {
  return { code, status, message, safeDetails };
}

function aggregate(checks: BackupHealthCheck[]): BackupHealthStatus {
  if (checks.some((item) => item.status === 'critical')) return 'critical';
  if (checks.some((item) => item.status === 'warning')) return 'warning';
  return 'ok';
}

function backupAlertTitle(code: string) {
  const titles: Record<string, string> = {
    'backup.no_successful_backup': 'No successful backup',
    'backup.success_too_old': 'Backup is too old',
    'backup.latest_failed': 'Latest backup failed',
    'backup.not_encrypted': 'Backup is not encrypted',
    'backup.checksum_missing': 'Backup checksum missing',
    'restore_drill.none': 'No restore drill',
    'restore_drill.too_old': 'Restore drill is too old',
    'restore_drill.latest_failed': 'Latest restore drill failed',
  };
  return titles[code] ?? code;
}
