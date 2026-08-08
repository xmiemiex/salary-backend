import { CommonStatus, Prisma } from '@prisma/client';
import { AppError } from '../common/app-error';
import { CakeIncomeAdjustmentsService } from './cake-income-adjustments.service';

const month = new Date('2026-07-01T00:00:00.000Z');
const accountId = '10000000-0000-0000-0000-000000000001';
const employeeId = '20000000-0000-0000-0000-000000000001';
const actor = { userId: 'admin-1', roleCode: 'super_admin', permissions: ['income.import'] };

describe('CakeIncomeAdjustmentsService', () => {
  function harness() {
    const prisma: any = {
      affiliateAccount: {
        findUnique: jest.fn().mockResolvedValue({ id: accountId, platform: 'cake', accountCode: '329', accountName: 'Blitzads' }),
      },
      subIdMapping: {
        findMany: jest.fn().mockResolvedValue([{ employeeId, employee: { status: CommonStatus.active } }]),
      },
      incomeRecord: {
        findMany: jest.fn().mockResolvedValue([{ employeeId, incomeUsd: new Prisma.Decimal('77385') }]),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockImplementation(async (args: any) => ({ id: 'adjustment-1', ...args.create })),
        update: jest.fn().mockImplementation(async (args: any) => ({ id: args.where.id, ...args.data })),
      },
    };
    const monthLock: any = { assertWritable: jest.fn().mockResolvedValue(undefined), isLocked: jest.fn().mockResolvedValue(false) };
    const audit: any = { success: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    return { service: new CakeIncomeAdjustmentsService(prisma, monthLock, audit), prisma, monthLock, audit };
  }

  const input = (actualRevenueUsd: string, reason = 'Portal China Standard Time月报核对') => ({
    affiliateAccountId: accountId,
    settlementMonth: '2026-07',
    subValue: 'ZW',
    actualRevenueUsd,
    reason,
  });

  it('creates a positive draft adjustment from CST target without modifying CAKE base income', async () => {
    const { service, prisma, audit } = harness();
    const result = await service.saveDraft(input('77710'), actor);
    expect(result.incomeUsd).toEqual(new Prisma.Decimal('325'));
    const write = prisma.incomeRecord.upsert.mock.calls[0][0];
    expect(write.create).toMatchObject({
      source: 'cake_adjustment',
      settlementMonth: month,
      subValue: 'ZW',
      employeeId,
      status: CommonStatus.draft,
      incomeUsd: new Prisma.Decimal('325'),
    });
    expect(write.create.rawData).toMatchObject({
      providerTimezone: 'cake_system_default',
      settlementTimezone: 'Asia/Shanghai',
      baseRevenueUsd: '77385',
      targetRevenueUsd: '77710',
      adjustmentUsd: '325',
      stale: false,
    });
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: 'cake_income_adjustment.save_draft' }));
  });

  it('supports a negative adjustment only through the dedicated source and repeated saves use one idempotency key', async () => {
    const { service, prisma } = harness();
    prisma.incomeRecord.findMany.mockResolvedValue([{ employeeId, incomeUsd: new Prisma.Decimal('3055') }]);
    await service.saveDraft({ ...input('2600'), subValue: 'YDF' }, actor);
    await service.saveDraft({ ...input('2600'), subValue: 'YDF' }, actor);
    const first = prisma.incomeRecord.upsert.mock.calls[0][0];
    const second = prisma.incomeRecord.upsert.mock.calls[1][0];
    expect(first.create.incomeUsd).toEqual(new Prisma.Decimal('-455'));
    expect(first.create.source).toBe('cake_adjustment');
    expect(second.where).toEqual(first.where);
  });

  it('does not create a zero adjustment', async () => {
    const { service, prisma } = harness();
    await expect(service.saveDraft(input('77385'), actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
  });

  it('rejects missing reasons, blank SUBs, missing API base rows and final revenue below zero', async () => {
    const { service, prisma } = harness();
    await expect(service.saveDraft(input('77710', ' '), actor)).rejects.toBeInstanceOf(AppError);
    await expect(service.saveDraft({ ...input('77710'), subValue: ' ' }, actor)).rejects.toBeInstanceOf(AppError);
    prisma.incomeRecord.findMany.mockResolvedValueOnce([]);
    await expect(service.saveDraft(input('10'), actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service.saveDraft(input('-1'), actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects missing and conflicting mappings, inactive employees and employee mismatches', async () => {
    const { service, prisma } = harness();
    prisma.subIdMapping.findMany.mockResolvedValueOnce([]);
    await expect(service.saveDraft(input('77710'), actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    prisma.subIdMapping.findMany.mockResolvedValueOnce([
      { employeeId: 'emp-1', employee: { status: CommonStatus.active } },
      { employeeId: 'emp-2', employee: { status: CommonStatus.active } },
    ]);
    await expect(service.saveDraft(input('77710'), actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    prisma.subIdMapping.findMany.mockResolvedValueOnce([{ employeeId, employee: { status: CommonStatus.disabled } }]);
    await expect(service.saveDraft(input('77710'), actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    prisma.subIdMapping.findMany.mockResolvedValueOnce([{ employeeId, employee: { status: CommonStatus.active } }]);
    prisma.incomeRecord.findMany.mockResolvedValueOnce([{ employeeId: 'other-employee', incomeUsd: new Prisma.Decimal('77385') }]);
    await expect(service.saveDraft(input('77710'), actor)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('enforces super_admin plus income.import and the month lock', async () => {
    const { service, monthLock, prisma } = harness();
    await expect(service.saveDraft(input('77710'), { ...actor, roleCode: 'admin' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.saveDraft(input('77710'), { ...actor, permissions: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    monthLock.assertWritable.mockRejectedValueOnce(new AppError('MONTH_LOCKED' as never, 'locked'));
    await expect(service.saveDraft(input('77710'), actor)).rejects.toMatchObject({ code: 'MONTH_LOCKED' });
    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
  });

  it('revalidates current base and mapping before confirmation and confirmed metadata is no longer stale', async () => {
    const { service, prisma } = harness();
    prisma.incomeRecord.findUnique.mockResolvedValue({
      id: 'adjustment-1',
      settlementMonth: month,
      affiliateAccountId: accountId,
      subValue: 'ZW',
      source: 'cake_adjustment',
      status: CommonStatus.draft,
      rawData: {
        kind: 'cake_sub_revenue_adjustment', basis: 'manual_china_standard_time',
        providerTimezone: 'cake_system_default', settlementTimezone: 'Asia/Shanghai',
        baseRevenueUsd: '77000', targetRevenueUsd: '77710', adjustmentUsd: '710', reason: '复核', stale: true,
      },
    });
    const result = await service.confirm('adjustment-1', actor);
    expect(result.status).toBe(CommonStatus.confirmed);
    expect(result.incomeUsd).toEqual(new Prisma.Decimal('325'));
    expect(result.rawData).toMatchObject({ baseRevenueUsd: '77385', targetRevenueUsd: '77710', stale: false });
  });

  it('exports base, adjustment and final Revenue without credential or raw payload fields', async () => {
    const { service, prisma } = harness();
    prisma.incomeRecord.findMany
      .mockResolvedValueOnce([{ id: 'base-1', employeeId, subValue: 'ZW', incomeUsd: new Prisma.Decimal('77385') }])
      .mockResolvedValueOnce([]);
    prisma.subIdMapping.findMany.mockResolvedValue([{
      subValue: 'ZW', employeeId, employee: { employeeCode: '01', name: 'ZW', status: CommonStatus.active },
    }]);
    const result = await service.exportCsv({ affiliateAccountId: accountId, settlementMonth: '2026-07' }, actor);
    expect(result.csv).toContain('API Default Timezone Revenue USD,China Standard Time Actual Revenue USD,Proposed Adjustment USD,Confirmed Adjustment USD,Preview Final Revenue USD,Settlement Final Revenue USD');
    expect(result.csv).toContain('77385,77385,0,0,77385,77385');
    expect(result.csv).not.toMatch(/api.?key|authorization|raw.?payload/i);
  });
});
