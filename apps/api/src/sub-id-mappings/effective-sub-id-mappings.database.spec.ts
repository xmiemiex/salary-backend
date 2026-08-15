import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CommonStatus, PrismaClient } from '@prisma/client';
import {
  EffectiveSubIdMappingReader,
  isUsableEffectiveSubIdMapping,
  resolveEffectiveSubIdMappings,
} from './effective-sub-id-mappings';

const databaseDescribe = process.env.TASK98_DATABASE_TESTS === '1' ? describe : describe.skip;

databaseDescribe('Task98 effective SUB mappings on isolated PostgreSQL', () => {
  jest.setTimeout(120_000);

  const baseUrl = process.env.DATABASE_URL ?? '';
  const schema = `task98_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = baseUrl ? withSchema(baseUrl, schema) : '';
  const root = path.resolve(__dirname, '../../../..');
  const june = new Date('2026-06-01T00:00:00.000Z');
  const august = new Date('2026-08-01T00:00:00.000Z');
  const september = new Date('2026-09-01T00:00:00.000Z');

  let admin: PrismaClient;
  let db: PrismaClient;
  let cakeA: string;
  let cakeB: string;
  let employeeOld: string;
  let employeeNew: string;
  let employeeDisabled: string;

  beforeAll(async () => {
    if (!baseUrl) throw new Error('DATABASE_URL is required when TASK98_DATABASE_TESTS=1.');
    admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    execFileSync(
      process.platform === 'win32' ? 'cmd.exe' : 'pnpm',
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'pnpm prisma migrate deploy']
        : ['prisma', 'migrate', 'deploy'],
      { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' },
    );
    db = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
    await db.$connect();

    const [oldEmployee, newEmployee, disabledEmployee, accountA, accountB] = await Promise.all([
      db.employee.create({ data: { employeeCode: 'T98-OLD', name: 'Old', status: CommonStatus.active } }),
      db.employee.create({ data: { employeeCode: 'T98-NEW', name: 'New', status: CommonStatus.active } }),
      db.employee.create({ data: { employeeCode: 'T98-DISABLED', name: 'Disabled', status: CommonStatus.disabled } }),
      db.affiliateAccount.create({ data: { platform: 'cake', accountCode: 'task98-cake-a', status: CommonStatus.active } }),
      db.affiliateAccount.create({ data: { platform: 'cake', accountCode: 'task98-cake-b', status: CommonStatus.active } }),
    ]);
    employeeOld = oldEmployee.id;
    employeeNew = newEmployee.id;
    employeeDisabled = disabledEmployee.id;
    cakeA = accountA.id;
    cakeB = accountB.id;

    await db.subIdMapping.createMany({ data: [
      { affiliateAccountId: cakeA, subField: 'sub1', subValue: 'ZW', effectiveMonth: june, employeeId: employeeOld, status: CommonStatus.active },
      { affiliateAccountId: cakeA, subField: 'sub1', subValue: 'ZW', effectiveMonth: september, employeeId: employeeNew, status: CommonStatus.active },
      { affiliateAccountId: cakeA, subField: 'sub1', subValue: 'DISABLED', effectiveMonth: june, employeeId: employeeOld, status: CommonStatus.active },
      { affiliateAccountId: cakeA, subField: 'sub1', subValue: 'DISABLED', effectiveMonth: september, employeeId: employeeOld, status: CommonStatus.disabled },
      { affiliateAccountId: cakeA, subField: 'sub1', subValue: 'INACTIVE_EMPLOYEE', effectiveMonth: june, employeeId: employeeDisabled, status: CommonStatus.active },
      { affiliateAccountId: cakeB, subField: 'sub1', subValue: 'ZW', effectiveMonth: june, employeeId: employeeOld, status: CommonStatus.active },
    ] });
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  it('carries June forward, excludes future versions, and applies the September replacement', async () => {
    await expect(resolve(cakeA, 'ZW', june)).resolves.toMatchObject([{ employeeId: employeeOld, effectiveMonth: june }]);
    await expect(resolve(cakeA, 'ZW', august)).resolves.toMatchObject([{ employeeId: employeeOld, effectiveMonth: june }]);
    await expect(resolve(cakeA, 'ZW', september)).resolves.toMatchObject([{ employeeId: employeeNew, effectiveMonth: september }]);
  });

  it('keeps the latest disabled version authoritative and exposes a disabled employee as unusable', async () => {
    const disabled = await resolve(cakeA, 'DISABLED', september);
    expect(disabled).toMatchObject([{ effectiveMonth: september, status: CommonStatus.disabled }]);
    expect(disabled.some(isUsableEffectiveSubIdMapping)).toBe(false);

    const inactiveEmployee = await resolve(cakeA, 'INACTIVE_EMPLOYEE', august);
    expect(inactiveEmployee).toMatchObject([{ employeeId: employeeDisabled, employee: { status: CommonStatus.disabled } }]);
    expect(inactiveEmployee.some(isUsableEffectiveSubIdMapping)).toBe(false);
  });

  it('isolates identical SUB values by account and permits one employee across multiple accounts', async () => {
    await expect(resolve(cakeA, 'ZW', august)).resolves.toMatchObject([{ affiliateAccountId: cakeA, employeeId: employeeOld }]);
    await expect(resolve(cakeB, 'ZW', august)).resolves.toMatchObject([{ affiliateAccountId: cakeB, employeeId: employeeOld }]);

    const employeeMappings = await resolveEffectiveSubIdMappings(db as unknown as EffectiveSubIdMappingReader, {
      settlementMonth: august,
      employeeId: employeeOld,
    });
    expect(new Set(employeeMappings.filter(isUsableEffectiveSubIdMapping).map((mapping) => mapping.affiliateAccountId))).toEqual(new Set([cakeA, cakeB]));
  });

  function resolve(affiliateAccountId: string, subValue: string, settlementMonth: Date) {
    return resolveEffectiveSubIdMappings(db as unknown as EffectiveSubIdMappingReader, {
      affiliateAccountId,
      subField: 'sub1',
      subValue,
      settlementMonth,
    });
  }
});

function withSchema(url: string, schema: string) {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}
