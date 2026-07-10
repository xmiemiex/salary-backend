import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { AuditLogsExportService } from '../apps/api/src/audit/audit-logs-export.service';
import { AuditService } from '../apps/api/src/audit/audit.service';

type EvidenceStatus = 'pass' | 'fail';

type CommandEvidence = {
  schemaVersion: 1;
  type: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  status: EvidenceStatus;
  exitCode: number;
  summary: Record<string, unknown>;
};

const root = findWorkspaceRoot(process.cwd());
const evidenceDir = resolve(root, 'tmp', 'release-evidence');
const pnpm = 'pnpm';
const prismaBin = 'prisma';

async function main() {
  const command = process.argv[2] ?? 'help';
  if (command === 'migration-status') {
    const result = runMigrationStatus(resolve(evidenceDir, 'migration-status.json'));
    process.exitCode = result.status === 'pass' ? 0 : 1;
    return;
  }
  if (command === 'audit-export-smoke') {
    const result = await runAuditExportSmoke(resolve(evidenceDir, 'audit-export-smoke.json'));
    process.exitCode = result.status === 'pass' ? 0 : 1;
    return;
  }
  if (command === 'preflight') {
    const result = await runPreflight();
    process.exitCode = result.status === 'pass' ? 0 : 1;
    return;
  }
  if (command === 'report') {
    const result = writeReleaseReport();
    process.exitCode = result.status === 'pass' ? 0 : 1;
    return;
  }
  console.error('Usage: tsx scripts/release-evidence.ts <migration-status|audit-export-smoke|preflight|report>');
  process.exitCode = 1;
}

function runMigrationStatus(outputPath: string): CommandEvidence {
  const startedAt = new Date();
  const checks: Record<string, unknown>[] = [];
  const validate = runCommand(pnpm, ['run', 'prisma:validate']);
  checks.push({ name: 'prisma validate', exitCode: validate.status, passed: validate.status === 0 });
  const generate = runCommand(pnpm, ['run', 'prisma:generate']);
  checks.push({ name: 'prisma generate', exitCode: generate.status, passed: generate.status === 0 });
  const migrateStatus = runCommand(pnpm, ['exec', prismaBin, 'migrate', 'status']);
  const migrateOutput = `${migrateStatus.stdout}\n${migrateStatus.stderr}`;
  const statusOk = migrateStatus.status === 0
    && !/Database schema is not empty|not in sync|following migration\(s\) have not yet been applied|failed|drift/i.test(migrateOutput);
  checks.push({
    name: 'prisma migrate status',
    exitCode: migrateStatus.status,
    passed: statusOk,
    outputSummary: summarizeText(migrateOutput),
  });
  const status = checks.every((item) => item.passed) ? 'pass' : 'fail';
  const evidence: CommandEvidence = {
    schemaVersion: 1,
    type: 'migration-status',
    command: 'pnpm run prisma:validate; pnpm run prisma:generate; pnpm exec prisma migrate status',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    status,
    exitCode: status === 'pass' ? 0 : 1,
    summary: {
      checks,
      pendingMigrations: statusOk ? false : 'unknown_or_present',
      drift: statusOk ? false : 'unknown_or_present',
      schemaParseError: validate.status === 0 ? false : true,
    },
  };
  writeJson(outputPath, evidence);
  console.log(`Migration evidence: ${outputPath}`);
  return evidence;
}

async function runAuditExportSmoke(outputPath: string): Promise<CommandEvidence> {
  const startedAt = new Date();
  const prisma = new PrismaClient();
  try {
    const auditService = new AuditService(prisma as never);
    const exportService = new AuditLogsExportService(prisma as never, auditService);
    const createdTo = new Date();
    const createdFrom = new Date(createdTo.getTime() - 60 * 60 * 1000);
    const result = await exportService.export({
      createdFrom: createdFrom.toISOString(),
      createdTo: createdTo.toISOString(),
    }, {
      userId: undefined as never,
      roleCode: 'release_preflight',
      permissions: ['audit_log.view', 'audit_log.export'],
      ipAddress: '127.0.0.1',
      userAgent: 'release-preflight',
    });
    const csvBytes = Buffer.byteLength(result.csv, 'utf8');
    const header = result.csv.split(/\r?\n/, 1)[0]?.replace(/^\uFEFF/, '') ?? '';
    const columns = header.split(',').map((column) => column.replace(/^"|"$/g, ''));
    const valid = csvBytes > 0
      && ['id', 'createdAt', 'action', 'objectType', 'result'].every((column) => columns.includes(column));
    const evidence: CommandEvidence = {
      schemaVersion: 1,
      type: 'audit-export-smoke',
      command: 'pnpm release:audit-export-smoke',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      status: valid ? 'pass' : 'fail',
      exitCode: valid ? 0 : 1,
      summary: {
        exportedCount: result.exportedCount,
        filename: result.filename,
        csvBytes,
        rangeMinutes: 60,
        auditAction: 'audit_logs.exported',
      },
    };
    writeJson(outputPath, evidence);
    console.log(`Audit export smoke evidence: ${outputPath}`);
    return evidence;
  } catch (error) {
    const evidence: CommandEvidence = {
      schemaVersion: 1,
      type: 'audit-export-smoke',
      command: 'pnpm release:audit-export-smoke',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'fail',
      exitCode: 1,
      summary: { error: error instanceof Error ? error.message : 'Audit export smoke failed.' },
    };
    writeJson(outputPath, evidence);
    console.error(evidence.summary.error);
    return evidence;
  } finally {
    await prisma.$disconnect();
  }
}

async function runPreflight(): Promise<CommandEvidence> {
  mkdirSync(evidenceDir, { recursive: true });
  const startedAt = new Date();
  const steps: Array<Record<string, unknown>> = [];
  let failed = false;

  const runStep = (name: string, command: string, args: string[], extraEnv: Record<string, string> = {}) => {
    if (failed) return;
    console.log(`\n== ${name} ==`);
    const result = runCommand(command, args, extraEnv);
    const passed = result.status === 0;
    steps.push({ name, command: [command, ...args].join(' '), exitCode: result.status, status: passed ? 'pass' : 'fail' });
    if (!passed) failed = true;
  };

  runStep('install', pnpm, ['install', '--frozen-lockfile']);
  const migration = !failed ? runMigrationStatus(resolve(evidenceDir, 'migration-status.json')) : null;
  if (migration) {
    steps.push({ name: 'migration status', command: 'pnpm release:migration-status', exitCode: migration.exitCode, status: migration.status });
    if (migration.status !== 'pass') failed = true;
  }
  runStep('env check', pnpm, ['run', 'env:check'], { RELEASE_EVIDENCE_PATH: resolve(evidenceDir, 'env-check.json') });
  runStep('tests', pnpm, ['run', 'test']);
  runStep('build', pnpm, ['run', 'build']);
  runStep('permissions e2e', pnpm, ['run', 'e2e:permissions'], { RELEASE_EVIDENCE_PATH: resolve(evidenceDir, 'e2e-permissions.json') });
  const auditExport = !failed ? await runAuditExportSmoke(resolve(evidenceDir, 'audit-export-smoke.json')) : null;
  if (auditExport) {
    steps.push({ name: 'audit export smoke', command: 'pnpm release:audit-export-smoke', exitCode: auditExport.exitCode, status: auditExport.status });
    if (auditExport.status !== 'pass') failed = true;
  }
  runStep('release check', pnpm, ['run', 'release:check', '--', '--json']);

  const status: EvidenceStatus = failed ? 'fail' : 'pass';
  const evidence: CommandEvidence = {
    schemaVersion: 1,
    type: 'release-preflight',
    command: 'pnpm release:preflight',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    status,
    exitCode: status === 'pass' ? 0 : 1,
    summary: {
      requiredSteps: steps,
      artifactDir: relativeArtifactPath(''),
      commit: process.env.GITHUB_SHA ?? process.env.BUILD_SOURCEVERSION ?? null,
      branch: process.env.GITHUB_REF_NAME ?? process.env.BUILD_SOURCEBRANCHNAME ?? 'local',
      runId: process.env.GITHUB_RUN_ID ?? process.env.BUILD_BUILDID ?? 'local',
    },
  };
  writeJson(resolve(evidenceDir, 'release-evidence.json'), evidence);
  writeReleaseReport();
  console.log(`\nRelease evidence: ${resolve(evidenceDir, 'release-evidence.json')}`);
  console.log(`Release report: ${resolve(evidenceDir, 'release-evidence.md')}`);
  return evidence;
}

function writeReleaseReport(): CommandEvidence {
  mkdirSync(evidenceDir, { recursive: true });
  const startedAt = new Date();
  const releaseEvidence = readJson(resolve(evidenceDir, 'release-evidence.json'));
  const migration = readJson(resolve(evidenceDir, 'migration-status.json'));
  const env = readJson(resolve(evidenceDir, 'env-check.json'));
  const e2e = readJson(resolve(evidenceDir, 'e2e-permissions.json'));
  const audit = readJson(resolve(evidenceDir, 'audit-export-smoke.json'));
  const ciFixture = readJson(resolve(evidenceDir, 'ci-fixture-context.json'));
  const releaseGate = runCommand(pnpm, ['run', 'release:check', '--', '--json']);
  const releaseGateJson = extractJson(releaseGate.stdout);
  if (releaseGateJson) writeJson(resolve(evidenceDir, 'release-gate.json'), releaseGateJson);
  const status: EvidenceStatus = releaseEvidence?.status === 'pass' && releaseGate.status === 0 ? 'pass' : 'fail';
  const warnings = Array.isArray(releaseGateJson?.checks)
    ? releaseGateJson.checks.filter((item: any) => item.status === 'warning').map((item: any) => item.code)
    : [];
  const requiredFailures = Array.isArray(releaseGateJson?.checks)
    ? releaseGateJson.checks.filter((item: any) => item.severity === 'required' && item.status === 'fail').map((item: any) => item.code)
    : [];
  const lines = [
    '# Release Evidence',
    '',
    `Generated at: ${new Date().toISOString()}`,
    `Current commit releasable: ${status === 'pass' && requiredFailures.length === 0 ? 'yes' : 'no'}`,
    `Manual approval needed: yes`,
    '',
    ...(ciFixture?.fixtureOnly === true ? [
      '## CI Fixture Boundary',
      '- Fixture only: yes',
      '- Production evidence: no',
      '- This run proves only that code and the release-gate chain executed against synthetic records in an ephemeral CI database.',
      '- It is not evidence of a production backup, restore drill, production database state, or production readiness.',
      '',
    ] : []),
    '## Artifacts',
    `- Release evidence: ${relativeArtifactPath('release-evidence.json')}`,
    `- Release gate JSON: ${relativeArtifactPath('release-gate.json')}`,
    `- Migration status: ${relativeArtifactPath('migration-status.json')}`,
    `- Env check: ${relativeArtifactPath('env-check.json')}`,
    `- E2E permissions: ${relativeArtifactPath('e2e-permissions.json')}`,
    `- Audit export smoke: ${relativeArtifactPath('audit-export-smoke.json')}`,
    ...(ciFixture?.fixtureOnly === true ? [`- CI fixture context: ${relativeArtifactPath('ci-fixture-context.json')}`] : []),
    '',
    '## Summary',
    `- Preflight status: ${releaseEvidence?.status ?? 'missing'}`,
    `- Migration status: ${migration?.status ?? 'missing'}`,
    `- Env check status: ${env?.status ?? 'missing'}`,
    `- E2E permissions status: ${e2e?.status ?? 'missing'}; checks=${e2e?.checksTotal ?? e2e?.summary?.checksTotal ?? 'unknown'}; cleanup=${e2e?.cleanup ?? 'unknown'}`,
    `- Audit export smoke status: ${audit?.status ?? 'missing'}; exportedCount=${audit?.summary?.exportedCount ?? 'unknown'}`,
    `- Release gate status: ${releaseGateJson?.status ?? 'unknown'}; pass=${releaseGateJson?.summary?.pass ?? 'unknown'} warning=${releaseGateJson?.summary?.warning ?? 'unknown'} fail=${releaseGateJson?.summary?.fail ?? 'unknown'}`,
    `- Required failures: ${requiredFailures.length ? requiredFailures.join(', ') : 'none'}`,
    `- Warnings: ${warnings.length ? warnings.join(', ') : 'none'}`,
    '',
    '## Approval',
    '- Human release approval must review this report, release-gate.json, and environment-specific deployment notes before production release.',
    '',
  ];
  writeFileSync(resolve(evidenceDir, 'release-evidence.md'), lines.join('\n'), 'utf8');
  const evidence: CommandEvidence = {
    schemaVersion: 1,
    type: 'release-report',
    command: 'pnpm release:report',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    status,
    exitCode: status === 'pass' ? 0 : 1,
    summary: {
      warnings,
      requiredFailures,
      reportPath: relativeArtifactPath('release-evidence.md'),
      fixtureOnly: ciFixture?.fixtureOnly === true,
      productionEvidence: ciFixture?.productionEvidence === true,
    },
  };
  writeJson(resolve(evidenceDir, 'release-report.json'), evidence);
  console.log(`Release report: ${resolve(evidenceDir, 'release-evidence.md')}`);
  return evidence;
}

function runCommand(command: string, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
    shell: process.platform === 'win32',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function extractJson(text: string): any | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function summarizeText(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/DATABASE_URL|password|token|secret|api[_-]?key|authorization|cookie|encrypted|credential/i.test(line))
    .slice(-12);
}

function relativeArtifactPath(fileName: string) {
  return fileName ? `tmp/release-evidence/${fileName}` : 'tmp/release-evidence';
}

function findWorkspaceRoot(start: string) {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  return resolve(start);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Release evidence command failed.');
  process.exitCode = 1;
});
