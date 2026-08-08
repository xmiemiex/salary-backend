import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  CommonStatus,
  Prisma,
  PrismaClient,
  SettlementStatus,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskStatus,
  SyncTaskType,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ManualIncomeRecordsService } from '../manual-income-records/manual-income-records.service';
import { MonthLockService } from '../month-lock/month-lock.service';
import { SettlementCalculatorService } from '../settlement/settlement-calculator.service';
import { SettlementGenerationService } from '../settlement/settlement-generation.service';
import { SettlementPreflightService } from '../settlement/settlement-preflight.service';
import { SyncUnmatchedEventsService } from '../sync-unmatched-events/sync-unmatched-events.service';
import { CAKE_MONTHLY_SUB_CALIBRATION_ACTION, CakeIncomeSyncAdapter } from '../sync-tasks/cake/cake-income-sync.adapter';
import { CakeIncomeAdjustmentsService } from './cake-income-adjustments.service';

const databaseDescribe = process.env.TASK96_DATABASE_TESTS === '1' ? describe : describe.skip;

databaseDescribe('Task96 CAKE adjustment real PostgreSQL integration', () => {
  jest.setTimeout(180_000);

  const baseUrl = process.env.DATABASE_URL ?? '';
  const schema = `task96_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = baseUrl ? withSchema(baseUrl, schema) : '';
  const root = path.resolve(__dirname, '../../../..');
  const month = new Date('2026-07-01T00:00:00.000Z');
  const actor = {
    userId: '96000000-0000-4000-8000-000000000001',
    roleCode: 'super_admin',
    permissions: ['income.import'],
  };
  const reason = '2026-07 CAKE Portal China Standard Time monthly revenue reconciliation';

  let admin: PrismaClient;
  let db: PrismaClient;
  let audit: AuditService;
  let monthLock: MonthLockService;
  let adjustments: CakeIncomeAdjustmentsService;
  let manualIncome: ManualIncomeRecordsService;
  let preflight: SettlementPreflightService;
  let generation: SettlementGenerationService;
  let accountId: string;
  let employeeZwId: string;
  let employeeYdfId: string;
  let employeeOtherId: string;

  beforeAll(async () => {
    if (!baseUrl) throw new Error('DATABASE_URL is required when TASK96_DATABASE_TESTS=1.');
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
    await db.adminUser.create({
      data: {
        id: actor.userId,
        username: 'task96-super-admin',
        passwordHash: 'test-only-hash',
        displayName: 'Task96 Super Admin',
        status: CommonStatus.active,
      },
    });
    const [employeeZw, employeeYdf, employeeOther] = await Promise.all([
      db.employee.create({ data: { employeeCode: 'T96-ZW', name: 'ZW', status: CommonStatus.active } }),
      db.employee.create({ data: { employeeCode: 'T96-YDF', name: 'YDF', status: CommonStatus.active } }),
      db.employee.create({ data: { employeeCode: 'T96-OTHER', name: 'Default Must Not Be Used', status: CommonStatus.active } }),
    ]);
    employeeZwId = employeeZw.id;
    employeeYdfId = employeeYdf.id;
    employeeOtherId = employeeOther.id;
    const account = await db.affiliateAccount.create({
      data: {
        platform: 'cake',
        accountCode: '329-task96-test',
        accountName: 'Blitzads Task96 Isolated',
        defaultEmployeeId: employeeOtherId,
        status: CommonStatus.active,
      },
    });
    accountId = account.id;
    await db.subIdMapping.createMany({
      data: [
        { affiliateAccountId: accountId, subField: 'sub1', subValue: 'ZW', effectiveMonth: month, employeeId: employeeZwId, status: CommonStatus.active },
        { affiliateAccountId: accountId, subField: 'sub1', subValue: 'YDF', effectiveMonth: month, employeeId: employeeYdfId, status: CommonStatus.active },
      ],
    });
    await db.affiliateAccountCredential.create({
      data: {
        affiliateAccountId: accountId,
        encryptedPayload: 'task96-test-only-encrypted-placeholder',
        maskedPayload: { configured: true, testOnly: true },
        status: CommonStatus.active,
      },
    });
    await db.monthlyExchangeRate.create({
      data: { settlementMonth: month, usdToRmbRate: new Prisma.Decimal('7'), status: CommonStatus.active, createdBy: actor.userId },
    });
    audit = new AuditService(db as never);
    monthLock = new MonthLockService(db as never, audit);
    adjustments = new CakeIncomeAdjustmentsService(db as never, monthLock, audit);
    manualIncome = new ManualIncomeRecordsService(db as never, monthLock, audit);
    preflight = new SettlementPreflightService(db as never);
    generation = new SettlementGenerationService(
      db as never,
      monthLock,
      audit,
      new SettlementCalculatorService(),
      preflight,
    );
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.monthlySettlementDetail.deleteMany();
    await db.monthlySettlement.deleteMany({ where: { settlementMonth: month } });
    await db.syncUnmatchedEvent.deleteMany({ where: { affiliateAccountId: accountId } });
    await db.syncTask.deleteMany({ where: { affiliateAccountId: accountId } });
    await db.auditLog.deleteMany();
    await db.incomeRecord.deleteMany({ where: { affiliateAccountId: accountId } });
    await db.employee.updateMany({
      where: { id: { in: [employeeZwId, employeeYdfId, employeeOtherId] } },
      data: { status: CommonStatus.active },
    });
    await db.subIdMapping.deleteMany({ where: { affiliateAccountId: accountId } });
    await db.subIdMapping.createMany({
      data: [
        { affiliateAccountId: accountId, subField: 'sub1', subValue: 'ZW', effectiveMonth: month, employeeId: employeeZwId, status: CommonStatus.active },
        { affiliateAccountId: accountId, subField: 'sub1', subValue: 'YDF', effectiveMonth: month, employeeId: employeeYdfId, status: CommonStatus.active },
      ],
    });
    await seedBase('ZW', employeeZwId, '77385');
    await seedBase('YDF', employeeYdfId, '3055');
  });

  it('creates positive and negative drafts, rejects zero, and repeated save updates one row', async () => {
    const positive = await adjustments.saveDraft(input('ZW', '77710'), actor);
    const negative = await adjustments.saveDraft(input('YDF', '2600'), actor);
    const repeated = await adjustments.saveDraft(input('YDF', '2600'), actor);

    expect(positive).toMatchObject({ source: 'cake_adjustment', status: CommonStatus.draft });
    expect(positive.incomeUsd.toString()).toBe('325');
    expect(negative.incomeUsd.toString()).toBe('-455');
    expect(repeated.id).toBe(negative.id);
    expect(await db.incomeRecord.count({ where: { source: 'cake_adjustment' } })).toBe(2);
    await expect(adjustments.saveDraft(input('ZW', '77385'), actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects invalid targets, missing base/mapping, inactive employee, conflicting mapping, and locked writes', async () => {
    await expect(adjustments.saveDraft(input('ZW', '-1'), actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(adjustments.saveDraft(input(' ', '1'), actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(adjustments.saveDraft(input('UNKNOWN', '1'), actor)).rejects.toMatchObject({ code: 'CONFLICT' });

    await db.subIdMapping.delete({
      where: { affiliateAccountId_subField_subValue_effectiveMonth: { affiliateAccountId: accountId, subField: 'sub1', subValue: 'ZW', effectiveMonth: month } },
    });
    await expect(adjustments.saveDraft(input('ZW', '77710'), actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    await db.subIdMapping.create({
      data: { affiliateAccountId: accountId, subField: 'sub1', subValue: 'ZW', effectiveMonth: month, employeeId: employeeZwId, status: CommonStatus.active },
    });
    await db.employee.update({ where: { id: employeeZwId }, data: { status: CommonStatus.disabled } });
    await expect(adjustments.saveDraft(input('ZW', '77710'), actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    await db.employee.update({ where: { id: employeeZwId }, data: { status: CommonStatus.active } });

    await expect(db.subIdMapping.create({
      data: { affiliateAccountId: accountId, subField: 'sub1', subValue: 'ZW', effectiveMonth: month, employeeId: employeeOtherId, status: CommonStatus.active },
    })).rejects.toMatchObject({ code: 'P2002' });

    await db.incomeRecord.delete({ where: { source_externalRecordId: { source: 'cake', externalRecordId: baseExternalId('YDF') } } });
    await expect(adjustments.saveDraft(input('YDF', '2600'), actor)).rejects.toMatchObject({ code: 'CONFLICT' });

    const draft = await adjustments.saveDraft(input('ZW', '77710'), actor);
    await db.monthlySettlement.create({
      data: { settlementMonth: month, status: SettlementStatus.locked, lockedAt: new Date(), lockedBy: actor.userId, lockReason: 'task96 test lock' },
    });
    await expect(adjustments.saveDraft(input('ZW', '77711'), actor)).rejects.toMatchObject({ code: 'MONTH_LOCKED' });
    await expect(adjustments.confirm(draft.id, actor)).rejects.toMatchObject({ code: 'MONTH_LOCKED' });
    await expect(adjustments.disable(draft.id, actor)).rejects.toMatchObject({ code: 'MONTH_LOCKED' });
  });

  it('draft is excluded, confirmed is included, and disabled is excluded from generated settlement', async () => {
    const draft = await adjustments.saveDraft(input('ZW', '77710'), actor);
    await generation.generateSettlement({
      settlementMonth: month,
      actor,
      acknowledgedWarningCodes: ['DRAFT_MANUAL_RECORDS'],
    });
    expect(await generatedIncome(employeeZwId)).toBe('77385');

    await adjustments.confirm(draft.id, actor);
    await generation.generateSettlement({ settlementMonth: month, actor });
    expect(await generatedIncome(employeeZwId)).toBe('77710');

    await adjustments.disable(draft.id, actor);
    await generation.generateSettlement({
      settlementMonth: month,
      actor,
      acknowledgedWarningCodes: ['DRAFT_MANUAL_RECORDS'],
    });
    expect(await generatedIncome(employeeZwId)).toBe('77385');
  });

  it('ordinary manual income rejects negatives while the dedicated adjustment path permits a legal negative delta', async () => {
    await expect(manualIncome.create({ settlementMonth: month, source: 'manual', incomeUsd: '-1', employeeId: employeeZwId }, actor))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await db.incomeRecord.count({ where: { source: 'manual' } })).toBe(0);
    const adjustment = await adjustments.saveDraft(input('YDF', '2600'), actor);
    expect(adjustment.incomeUsd.toString()).toBe('-455');
  });

  it('writes base plus unmatched atomically and a second identical sync is idempotent without defaultEmployeeId fallback', async () => {
    const task = await createTask();
    await calibrate();
    const client = clientWithRows([
      { sub_id: 'ZW', revenue: '77385' },
      { sub_id: '', revenue: '195' },
      { sub_id: 'RRR', revenue: '0' },
    ]);
    const adapter = realAdapter(client);
    const first = await adapter.execute(context(task.id));
    const second = await adapter.execute(context(task.id));

    expect(first.resultPayload).toMatchObject({ pulledCount: 3, attributedCount: 1, unmatchedCount: 1, zeroRevenueCount: 1 });
    expect(second.resultPayload).toMatchObject({ pulledCount: 3, attributedCount: 1, unmatchedCount: 1, zeroRevenueCount: 1 });
    expect(await db.incomeRecord.count({ where: { source: 'cake', subValue: 'ZW' } })).toBe(1);
    expect(await db.syncUnmatchedEvent.count({ where: { affiliateAccountId: accountId, amountUsd: new Prisma.Decimal('195') } })).toBe(1);
    expect(await db.incomeRecord.count({ where: { employeeId: employeeOtherId, source: 'cake' } })).toBe(0);
  });

  it('rolls back the whole monthly batch when a later income write fails', async () => {
    const task = await createTask();
    await calibrate();
    const client = clientWithRows([{ sub_id: 'ZW', revenue: '80000' }, { sub_id: 'YDF', revenue: '4000' }]);
    const adapter = new CakeIncomeSyncAdapter(failingTransactionPrisma() as never, client as never, new SyncUnmatchedEventsService(db as never, audit), audit);
    const result = await adapter.execute(context(task.id));

    expect(result.status).toBe('failed');
    expect((await baseRow('ZW')).incomeUsd.toString()).toBe('77385');
    expect((await baseRow('YDF')).incomeUsd.toString()).toBe('3055');
  });

  it('marks a changed-base adjustment stale/draft in the same transaction and blocks preflight plus generation', async () => {
    const draft = await adjustments.saveDraft(input('ZW', '77710'), actor);
    await adjustments.confirm(draft.id, actor);
    const task = await createTask();
    await calibrate();
    const result = await realAdapter(clientWithRows([{ sub_id: 'ZW', revenue: '77000' }, { sub_id: '', revenue: '195' }]))
      .execute(context(task.id));
    expect(result.status).toBe('completed');

    const stale = await db.incomeRecord.findUniqueOrThrow({ where: { id: draft.id } });
    expect(stale).toMatchObject({ status: CommonStatus.draft });
    expect(stale.incomeUsd.toString()).toBe('710');
    expect(stale.rawData).toMatchObject({ stale: true, previousBaseRevenueUsd: '77385', currentBaseRevenueUsd: '77000' });
    const check = await preflight.check(month);
    expect(check.summary.staleCakeAdjustmentCount).toBe(1);
    expect(check.checks).toContainEqual(expect.objectContaining({ code: 'STALE_CAKE_INCOME_ADJUSTMENTS', severity: 'blocking' }));
    await expect(generation.generateSettlement({ settlementMonth: month, actor })).rejects.toMatchObject({ code: 'SETTLEMENT_PRECHECK_FAILED' });
    expect(await db.monthlySettlement.count({ where: { settlementMonth: month } })).toBe(0);
    expect(await db.syncUnmatchedEvent.count({ where: { affiliateAccountId: accountId, amountUsd: new Prisma.Decimal('195') } })).toBe(1);
  });

  it('keeps a confirmed adjustment valid when a repeated API sync leaves the base unchanged', async () => {
    const draft = await adjustments.saveDraft(input('ZW', '77710'), actor);
    await adjustments.confirm(draft.id, actor);
    const task = await createTask();
    await calibrate();
    await realAdapter(clientWithRows([{ sub_id: 'ZW', revenue: '77385' }])).execute(context(task.id));

    const current = await db.incomeRecord.findUniqueOrThrow({ where: { id: draft.id } });
    expect(current.status).toBe(CommonStatus.confirmed);
    expect(current.incomeUsd.toString()).toBe('325');
    expect(current.rawData).toMatchObject({ stale: false, baseRevenueUsd: '77385' });
    expect(await db.incomeRecord.count({ where: { source: 'cake', subValue: 'ZW' } })).toBe(1);
  });

  it('persists complete safe audits without provider credentials or raw payloads', async () => {
    const draft = await adjustments.saveDraft(input('ZW', '77710'), actor);
    await adjustments.confirm(draft.id, actor);
    const audits = await db.auditLog.findMany({ where: { objectId: draft.id }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((row) => row.action)).toEqual([
      'cake_income_adjustment.save_draft',
      'cake_income_adjustment.confirm',
    ]);
    const text = JSON.stringify(audits);
    expect(text).toContain(reason);
    expect(text).not.toMatch(/api.?key|authorization|cookie|password|encrypted.?payload|raw.?payload|provider.?response/i);
  });

  function input(subValue: string, actualRevenueUsd: string) {
    return { affiliateAccountId: accountId, settlementMonth: '2026-07', subValue, actualRevenueUsd, reason };
  }

  async function seedBase(subValue: string, employeeId: string, incomeUsd: string) {
    return db.incomeRecord.create({
      data: {
        settlementMonth: month,
        affiliateAccountId: accountId,
        employeeId,
        source: 'cake',
        externalRecordId: baseExternalId(subValue),
        subField: 'sub1',
        subValue,
        incomeUsd: new Prisma.Decimal(incomeUsd),
        rawData: { report: 'monthly_revenue_by_sub1', providerTimezone: 'cake_system_default' },
        status: CommonStatus.confirmed,
        importedBy: actor.userId,
      },
    });
  }

  function baseExternalId(subValue: string) {
    const digest = createHash('sha256').update(subValue).digest('hex').slice(0, 24);
    return `cake:sub-month:${accountId}:2026-07:${digest}`;
  }

  async function baseRow(subValue: string) {
    return db.incomeRecord.findUniqueOrThrow({
      where: { source_externalRecordId: { source: 'cake', externalRecordId: baseExternalId(subValue) } },
    });
  }

  async function generatedIncome(employeeId: string) {
    const row = await db.monthlySettlementDetail.findFirstOrThrow({ where: { settlementMonth: month, employeeId } });
    return row.incomeUsd.toString();
  }

  async function createTask() {
    return db.syncTask.create({
      data: {
        sourceType: SyncTaskSourceType.affiliate_income,
        taskType: SyncTaskType.affiliate_income,
        platform: SyncTaskPlatform.cake,
        affiliateAccountId: accountId,
        settlementMonth: month,
        status: SyncTaskStatus.running,
        requestedBy: actor.userId,
      },
    });
  }

  async function calibrate() {
    return db.auditLog.create({
      data: {
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: CAKE_MONTHLY_SUB_CALIBRATION_ACTION,
        objectType: 'affiliate_accounts',
        objectId: accountId,
        result: 'success',
        afterData: { rawPayloadReturned: false, providerTimezone: 'cake_system_default' },
      },
    });
  }

  function clientWithRows(rows: Array<{ sub_id: string; revenue: string }>) {
    return {
      getSubAffiliateSummary: jest.fn().mockResolvedValue({ rows, rowCount: rows.length, httpStatus: 200, raw: {} }),
    };
  }

  function realAdapter(client: ReturnType<typeof clientWithRows>) {
    return new CakeIncomeSyncAdapter(
      db as never,
      client as never,
      new SyncUnmatchedEventsService(db as never, audit),
      audit,
    );
  }

  function context(taskId: string) {
    return {
      taskId,
      sourceType: SyncTaskSourceType.affiliate_income,
      taskType: SyncTaskType.affiliate_income,
      platform: SyncTaskPlatform.cake,
      settlementMonth: month,
      affiliateAccountId: accountId,
      affiliateAccountCode: '329-task96-test',
      requestedBy: actor.userId,
      credential: {
        credentialId: 'task96-test-credential',
        hasCredential: true as const,
        maskedPayload: { configured: true },
        payload: { apiKey: 'task96-test-only-value', baseUrl: 'https://cake.invalid/affiliates/api' },
      },
    };
  }

  function failingTransactionPrisma() {
    return {
      affiliateAccountCredential: {
        findUnique: (args: Parameters<typeof db.affiliateAccountCredential.findUnique>[0]) => db.affiliateAccountCredential.findUnique(args),
      },
      auditLog: {
        findFirst: (args: Parameters<typeof db.auditLog.findFirst>[0]) => db.auditLog.findFirst(args),
      },
      $transaction: (callback: (transaction: unknown) => Promise<unknown>) => db.$transaction(async (tx) => {
        let writes = 0;
        const transaction = {
          subIdMapping: { findMany: (args: never) => tx.subIdMapping.findMany(args) },
          incomeRecord: {
            upsert: async (args: never) => {
              writes += 1;
              if (writes === 2) throw new Error('task96 simulated second write failure');
              return tx.incomeRecord.upsert(args);
            },
            deleteMany: (args: never) => tx.incomeRecord.deleteMany(args),
            findUnique: (args: never) => tx.incomeRecord.findUnique(args),
            update: (args: never) => tx.incomeRecord.update(args),
          },
          syncUnmatchedEvent: {
            findUnique: (args: never) => tx.syncUnmatchedEvent.findUnique(args),
            update: (args: never) => tx.syncUnmatchedEvent.update(args),
            create: (args: never) => tx.syncUnmatchedEvent.create(args),
          },
          auditLog: { create: (args: never) => tx.auditLog.create(args) },
        };
        return callback(transaction);
      }),
    };
  }
});

function withSchema(url: string, schema: string) {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}
