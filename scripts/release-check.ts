import { PrismaClient } from '@prisma/client';
import { BackupHealthService } from '../apps/api/src/backup-recovery/backup-health.service';
import { ReleaseGateChecker } from '../apps/api/src/release-gate/release-gate.checker';
import { containsSensitiveReleaseGateField } from '../apps/api/src/release-gate/release-gate-sanitizer';
import { SystemHealthService } from '../apps/api/src/system-health/system-health.service';

const prisma = new PrismaClient();

async function main() {
  const json = process.argv.includes('--json');
  const backupHealth = new BackupHealthService(prisma as never);
  const systemHealth = new SystemHealthService(prisma as never, backupHealth);
  const checker = new ReleaseGateChecker({
    prisma,
    getBackupHealth: (now) => backupHealth.getHealth(now),
    getSystemHealth: (now) => systemHealth.getSystemHealth(now),
  });
  const result = await checker.run();

  if (containsSensitiveReleaseGateField(result)) {
    console.error('Release gate output contains sensitive-looking content. Refusing to print full result.');
    process.exitCode = 2;
    return;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  if (result.checks.some((item) => item.severity === 'required' && item.status === 'fail')) {
    process.exitCode = 1;
  }
}

function printHuman(result: Awaited<ReturnType<ReleaseGateChecker['run']>>) {
  console.log(`Release gate status: ${result.status}`);
  console.log(`Generated at: ${result.generatedAt}`);
  console.log(`Summary: pass=${result.summary.pass} warning=${result.summary.warning} fail=${result.summary.fail}`);
  console.log('');
  for (const severity of ['required', 'recommended'] as const) {
    console.log(`${severity.toUpperCase()} checks`);
    for (const item of result.checks.filter((check) => check.severity === severity)) {
      console.log(`- [${item.status}] ${item.code}: ${item.message}`);
      if (item.status !== 'pass') console.log(`  remediation: ${item.remediation}`);
    }
    console.log('');
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'Release gate failed.');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
