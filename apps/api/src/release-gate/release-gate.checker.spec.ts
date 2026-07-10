import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CommonStatus } from '@prisma/client';
import { ReleaseGateChecker } from './release-gate.checker';
import { containsSensitiveReleaseGateField } from './release-gate-sanitizer';

describe('ReleaseGateChecker', () => {
  const now = new Date('2026-07-09T08:00:00.000Z');

  it('aggregates all pass as pass', async () => {
    const result = await new ReleaseGateChecker({ prisma: prismaMock(), now, getBackupHealth: async () => ({ status: 'ok', daysSinceLastSuccessBackup: 0, daysSinceLastSuccessDrill: 0 }), getSystemHealth: async () => ({ status: 'ok' }) }).run();
    expect(['pass', 'warning']).toContain(result.status);
    expect(['pass', 'warning']).toContain(result.checks.find((item) => item.code === 'E2E_PERMISSIONS_RECENT_RUN')?.status);
  });

  it('turns required check failure into fail', async () => {
    const prisma = prismaMock({ enabledSuperAdmins: 0, totalSuperAdmins: 1 });
    const result = await new ReleaseGateChecker({ prisma, now, getBackupHealth: async () => ({ status: 'ok', daysSinceLastSuccessBackup: 0, daysSinceLastSuccessDrill: 0 }), getSystemHealth: async () => ({ status: 'ok' }) }).run();
    expect(result.status).toBe('fail');
    expect(result.checks.find((item) => item.code === 'ENABLED_SUPER_ADMIN_PRESENT')?.status).toBe('fail');
  });

  it('handles migration unknown as warning', async () => {
    const prisma = prismaMock({ migrationThrows: true });
    const result = await new ReleaseGateChecker({ prisma, now }).run();
    expect(result.checks.find((item) => item.code === 'MIGRATIONS_UP_TO_DATE')?.status).toBe('warning');
  });

  it('checks super_admin count and permission completeness', async () => {
    const prisma = prismaMock({ missingPermissions: ['release_gate.run'] });
    const result = await new ReleaseGateChecker({ prisma, now }).run();
    expect(result.checks.find((item) => item.code === 'ENABLED_SUPER_ADMIN_PRESENT')?.status).toBe('pass');
    expect(result.checks.find((item) => item.code === 'PERMISSIONS_TABLE_COMPLETE')?.status).toBe('fail');
  });

  it('fails on active critical alerts and stale backup metadata', async () => {
    const prisma = prismaMock({ criticalAlerts: 1, latestBackupAgeHours: 100, latestDrillAgeDays: 100 });
    const result = await new ReleaseGateChecker({ prisma, now, getBackupHealth: async () => ({ status: 'critical', daysSinceLastSuccessBackup: 4, daysSinceLastSuccessDrill: 100 }) }).run();
    expect(result.checks.find((item) => item.code === 'ACTIVE_CRITICAL_ALERTS_ZERO')?.status).toBe('fail');
    expect(result.checks.find((item) => item.code === 'RECENT_FULL_BACKUP_WITHIN_72H')?.status).toBe('fail');
    expect(result.checks.find((item) => item.code === 'RECENT_RESTORE_DRILL_WITHIN_90D')?.status).toBe('fail');
  });

  it('detects test data residue and env check availability', async () => {
    const prisma = prismaMock({ residueCount: 2 });
    const result = await new ReleaseGateChecker({ prisma, now }).run();
    expect(result.checks.find((item) => item.code === 'TEST_DATA_RESIDUE_ZERO')?.status).toBe('fail');
    const root = path.resolve(__dirname, '../../../..');
    const envStatus = result.checks.find((item) => item.code === 'ENV_CHECK_AVAILABLE')?.status;
    if (existsSync(path.join(root, 'scripts/check-environment.ps1'))) {
      expect(['pass', 'warning']).toContain(envStatus);
    } else {
      expect(envStatus).toBe('fail');
    }
  });

  it('sanitizes sensitive fields', () => {
    expect(containsSensitiveReleaseGateField({ password: 'x' })).toBe(true);
    expect(containsSensitiveReleaseGateField({ safeDetails: { count: 1 } })).toBe(false);
  });

  it('supports CLI JSON output without sensitive fields', () => {
    const root = path.resolve(__dirname, '../../../..');
    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm release:check -- --json'], { cwd: root, encoding: 'utf8' })
      : spawnSync('pnpm', ['release:check', '--', '--json'], { cwd: root, encoding: 'utf8' });
    const output = result.stdout;
    expect(output).toContain('"checks"');
    const parsed = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('checks');
    expect(output).not.toMatch(/passwordHash|tokenHash|DATABASE_URL|encryptedPayload|credentialPayload|leaseOwner/i);
  }, 60_000);
});

function prismaMock(options: Record<string, unknown> = {}) {
  const permissions = jest.requireActual('@salary/shared').PERMISSIONS as string[];
  const missingPermissions = new Set(options.missingPermissions as string[] | undefined);
  const now = new Date('2026-07-09T08:00:00.000Z');
  const latestBackupAgeHours = Number(options.latestBackupAgeHours ?? 1);
  const latestDrillAgeDays = Number(options.latestDrillAgeDays ?? 1);
  const countByModel = Number(options.residueCount ?? 0);
  return {
    $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
      const sql = Array.isArray(parts) ? String(parts[0]) : '';
      if (sql.includes('_prisma_migrations')) {
        if (options.migrationThrows) throw new Error('migration unavailable');
        return [{ migration_name: '20260709010000_test', finished_at: now, rolled_back_at: null }];
      }
      return [{ '?column?': 1 }];
    }),
    $queryRawUnsafe: jest.fn(async () => [{ ok: 1 }]),
    permission: { findMany: jest.fn(async () => permissions.filter((code) => !missingPermissions.has(code)).map((code) => ({ code }))) },
    role: { findUnique: jest.fn(async () => ({ permissions: permissions.filter((code) => !missingPermissions.has(code)).map((code) => ({ permission: { code } })) })) },
    auditLog: {
      count: jest.fn(async () => 1),
      findFirst: jest.fn(async () => ({ createdAt: now })),
    },
    alert: { count: jest.fn(async ({ where }: any) => where?.severity === 'critical' ? Number(options.criticalAlerts ?? 0) : 0) },
    affiliateAccount: { count: jest.fn(async () => 0) },
    cardProviderCredential: { findMany: jest.fn(async () => [{ provider: 'airwallex' }, { provider: 'photonpay' }]) },
    employee: { count: jest.fn(async () => 0) },
    syncTask: { count: jest.fn(async () => 0) },
    adminSession: { count: jest.fn(async () => 0) },
    syncPlanningRun: { count: jest.fn(async () => 0) },
    notification: { count: jest.fn(async () => 0) },
    adminUserRole: { count: jest.fn(async () => 0) },
    // Delegates used by countPrefixes.
    adminUser: { count: jest.fn(async ({ where }: any) => where?.OR ? countByModel : (where?.status === CommonStatus.active ? Number(options.enabledSuperAdmins ?? 1) : Number(options.totalSuperAdmins ?? 1))) },
    backupRecord: {
      count: jest.fn(async () => countByModel),
      findFirst: jest.fn(async () => ({ completedAt: new Date(now.getTime() - latestBackupAgeHours * 60 * 60 * 1000), startedAt: now })),
    },
    restoreDrillRecord: {
      count: jest.fn(async () => countByModel),
      findFirst: jest.fn(async () => ({ completedAt: new Date(now.getTime() - latestDrillAgeDays * 24 * 60 * 60 * 1000), startedAt: now })),
    },
  };
}
