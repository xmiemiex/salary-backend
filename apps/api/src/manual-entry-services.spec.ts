import { CommonStatus, Prisma, SalaryItemType, SalaryMode, SettlementStatus } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from './audit/audit.service';
import { AppError } from './common/app-error';
import { HistoricalNegativeProfitsService } from './historical-negative-profits/historical-negative-profits.service';
import { ManualCardSpendEntriesService } from './manual-card-spend-entries/manual-card-spend-entries.service';
import { ManualIncomeRecordsService } from './manual-income-records/manual-income-records.service';
import { MonthLockService } from './month-lock/month-lock.service';
import { PerformanceGroupsService } from './performance-groups/performance-groups.service';
import { MonthlySalaryManualItemsService } from './salary-manual-items/monthly-salary-manual-items.service';
import { SalaryItemConfigsService } from './salary-manual-items/salary-item-configs.service';

describe('manual settlement input services', () => {
  const actor = { userId: '00000000-0000-0000-0000-000000000001', roleCode: 'finance' };
  const settlementMonth = new Date('2026-05-01T00:00:00.000Z');

  function duplicateError() {
    return new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    });
  }

  function createHarness() {
    const prisma: Record<string, any> = {
      incomeRecord: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      manualCardSpendEntry: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      historicalNegativeProfit: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      monthlyPerformanceGroup: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      monthlyPerformanceGroupMember: {
        findFirst: jest.fn(),
        createMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      salaryItemConfig: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      monthlySalaryManualItem: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => unknown) => callback(prisma));
    const audit = {
      success: jest.fn().mockResolvedValue(undefined),
      failure: jest.fn().mockResolvedValue(undefined),
    };
    const monthLock = {
      assertWritable: jest.fn().mockResolvedValue(undefined),
    };
    return {
      prisma,
      audit,
      monthLock,
      manualIncome: new ManualIncomeRecordsService(
        prisma as never,
        monthLock as unknown as MonthLockService,
        audit as unknown as AuditService,
      ),
      manualCardSpend: new ManualCardSpendEntriesService(
        prisma as never,
        monthLock as unknown as MonthLockService,
        audit as unknown as AuditService,
      ),
      historicalNegativeProfits: new HistoricalNegativeProfitsService(
        prisma as never,
        monthLock as unknown as MonthLockService,
        audit as unknown as AuditService,
      ),
      performanceGroups: new PerformanceGroupsService(
        prisma as never,
        monthLock as unknown as MonthLockService,
        audit as unknown as AuditService,
      ),
      salaryItemConfigs: new SalaryItemConfigsService(prisma as never, audit as unknown as AuditService),
      monthlySalaryManualItems: new MonthlySalaryManualItemsService(
        prisma as never,
        monthLock as unknown as MonthLockService,
        audit as unknown as AuditService,
      ),
    };
  }

  it('creates manual income draft, audits success, stores Decimal from string, and rejects locked months', async () => {
    const { manualIncome, prisma, monthLock, audit } = createHarness();
    prisma.incomeRecord.create.mockResolvedValue({
      id: 'income-1',
      settlementMonth,
      source: 'manual',
      incomeUsd: new Prisma.Decimal('123.45'),
      status: CommonStatus.draft,
    });

    await manualIncome.create({ settlementMonth: '2026-05-01', source: 'manual', incomeUsd: '123.45' }, actor);

    expect(monthLock.assertWritable).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementMonth,
        action: 'manual_income_record.create',
        objectType: 'income_records',
      }),
      actor,
    );
    expect(prisma.incomeRecord.create.mock.calls[0][0].data.incomeUsd).toBeInstanceOf(Prisma.Decimal);
    expect(prisma.incomeRecord.create.mock.calls[0][0].data.incomeUsd.toString()).toBe('123.45');
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'manual_income_record.create',
        objectId: 'income-1',
      }),
    );

    const lockedError = new AppError(ERROR_CODES.MONTH_LOCKED, 'locked');
    monthLock.assertWritable.mockRejectedValueOnce(lockedError);
    prisma.incomeRecord.create.mockClear();
    await expect(
      manualIncome.create({ settlementMonth: '2026-05-01', source: 'manual', incomeUsd: '1' }, actor),
    ).rejects.toBe(lockedError);
    expect(prisma.incomeRecord.create).not.toHaveBeenCalled();
  });

  it('rejects manual income confirm when employeeId is empty', async () => {
    const { manualIncome, prisma } = createHarness();
    prisma.incomeRecord.findUnique.mockResolvedValue({
      id: 'income-1',
      settlementMonth,
      employeeId: null,
      status: CommonStatus.draft,
    });

    await expect(manualIncome.confirm('income-1', actor)).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
    });
    expect(prisma.incomeRecord.update).not.toHaveBeenCalled();
  });

  it('auto-calculates manual card spend actualSpendUsd as 10000 * (1 + 0.05) = 10500', async () => {
    const { manualCardSpend, prisma } = createHarness();
    prisma.manualCardSpendEntry.create.mockResolvedValue({
      id: 'card-1',
      settlementMonth,
      actualSpendUsd: new Prisma.Decimal('10500'),
      status: SettlementStatus.draft,
    });

    await manualCardSpend.create(
      {
        settlementMonth: '2026-05-01',
        employeeId: 'emp-1',
        providerName: 'Wise virtual card',
        settledSpendUsd: '10000',
        feeRate: '0.05',
      },
      actor,
    );

    const data = prisma.manualCardSpendEntry.create.mock.calls[0][0].data;
    expect(data.settledSpendUsd.toString()).toBe('10000');
    expect(data.feeRate.toString()).toBe('0.05');
    expect(data.actualSpendUsd).toBeInstanceOf(Prisma.Decimal);
    expect(data.actualSpendUsd.toString()).toBe('10500');
  });

  it('blocks manual card spend confirm for locked months', async () => {
    const { manualCardSpend, prisma, monthLock, audit } = createHarness();
    const lockedError = new AppError(ERROR_CODES.MONTH_LOCKED, 'locked');
    prisma.manualCardSpendEntry.findUnique.mockResolvedValue({
      id: 'card-1',
      settlementMonth,
      status: SettlementStatus.draft,
    });
    monthLock.assertWritable.mockRejectedValueOnce(lockedError);

    await expect(manualCardSpend.confirm('card-1', actor)).rejects.toBe(lockedError);

    expect(prisma.manualCardSpendEntry.update).not.toHaveBeenCalled();
    expect(audit.failure).not.toHaveBeenCalled();
  });

  it('rejects negative historical negative profit amount', async () => {
    const { historicalNegativeProfits } = createHarness();

    await expect(
      historicalNegativeProfits.create(
        { settlementMonth: '2026-05-01', employeeId: 'emp-1', amountUsd: '-1' },
        actor,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
  });

  it('rejects performance group allocationRatio sum not equal to 1', async () => {
    const { performanceGroups } = createHarness();

    await expect(
      performanceGroups.create(
        {
          settlementMonth: '2026-05-01',
          name: 'Team A',
          members: [
            { employeeId: 'emp-1', allocationRatio: '0.4' },
            { employeeId: 'emp-2', allocationRatio: '0.5' },
          ],
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
  });

  it('rejects performance group duplicate employee membership for the same month', async () => {
    const { performanceGroups, prisma } = createHarness();
    prisma.monthlyPerformanceGroupMember.findFirst.mockResolvedValue({
      id: 'member-existing',
      settlementMonth,
      employeeId: 'emp-1',
      groupId: 'group-existing',
    });

    await expect(
      performanceGroups.create(
        {
          settlementMonth: '2026-05-01',
          name: 'Team A',
          members: [{ employeeId: 'emp-1', allocationRatio: '1' }],
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
  });

  it('updates performance group members by transactionally deleting and recreating the full set', async () => {
    const { performanceGroups, prisma, audit } = createHarness();
    prisma.monthlyPerformanceGroup.findUnique.mockResolvedValue({
      id: 'group-1',
      settlementMonth,
      name: 'Team A',
      salaryMode: SalaryMode.group,
      status: CommonStatus.active,
      members: [{ id: 'member-old', groupId: 'group-1', settlementMonth, employeeId: 'emp-old', allocationRatio: new Prisma.Decimal('1') }],
    });
    prisma.monthlyPerformanceGroupMember.findFirst.mockResolvedValue(null);
    prisma.monthlyPerformanceGroup.update.mockResolvedValue({
      id: 'group-1',
      settlementMonth,
      name: 'Team A2',
      salaryMode: SalaryMode.group,
      status: CommonStatus.active,
    });
    prisma.monthlyPerformanceGroupMember.deleteMany.mockResolvedValue({ count: 1 });
    prisma.monthlyPerformanceGroupMember.createMany.mockResolvedValue({ count: 2 });

    await performanceGroups.update(
      'group-1',
      {
        name: 'Team A2',
        members: [
          { employeeId: 'emp-1', allocationRatio: '0.5' },
          { employeeId: 'emp-2', allocationRatio: '0.5' },
        ],
      },
      actor,
    );

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.monthlyPerformanceGroupMember.deleteMany).toHaveBeenCalledWith({ where: { groupId: 'group-1' } });
    expect(prisma.monthlyPerformanceGroupMember.createMany).toHaveBeenCalledWith({
      data: [
        { settlementMonth, groupId: 'group-1', employeeId: 'emp-1', allocationRatio: expect.any(Prisma.Decimal) },
        { settlementMonth, groupId: 'group-1', employeeId: 'emp-2', allocationRatio: expect.any(Prisma.Decimal) },
      ],
    });
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'performance_group.update',
        afterData: expect.objectContaining({
          group: expect.objectContaining({ id: 'group-1' }),
          members: expect.any(Array),
        }),
      }),
      prisma,
    );
  });

  it('rejects performance group update with settlementMonth but without members replacement', async () => {
    const { performanceGroups, prisma } = createHarness();
    prisma.monthlyPerformanceGroup.findUnique.mockResolvedValue({
      id: 'group-1',
      settlementMonth,
      name: 'Team A',
      salaryMode: SalaryMode.group,
      status: CommonStatus.active,
      members: [{ id: 'member-old', groupId: 'group-1', settlementMonth, employeeId: 'emp-old', allocationRatio: new Prisma.Decimal('1') }],
    });

    await expect(
      performanceGroups.update('group-1', { settlementMonth: '2026-06-01' }, actor),
    ).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
    });

    expect(prisma.monthlyPerformanceGroup.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('updates performance group settlementMonth with members replacement using new member settlementMonth', async () => {
    const { performanceGroups, prisma } = createHarness();
    const newSettlementMonth = new Date('2026-06-01T00:00:00.000Z');
    prisma.monthlyPerformanceGroup.findUnique.mockResolvedValue({
      id: 'group-1',
      settlementMonth,
      name: 'Team A',
      salaryMode: SalaryMode.group,
      status: CommonStatus.active,
      members: [{ id: 'member-old', groupId: 'group-1', settlementMonth, employeeId: 'emp-old', allocationRatio: new Prisma.Decimal('1') }],
    });
    prisma.monthlyPerformanceGroupMember.findFirst.mockResolvedValue(null);
    prisma.monthlyPerformanceGroup.update.mockResolvedValue({
      id: 'group-1',
      settlementMonth: newSettlementMonth,
      name: 'Team A',
      salaryMode: SalaryMode.group,
      status: CommonStatus.active,
    });
    prisma.monthlyPerformanceGroupMember.deleteMany.mockResolvedValue({ count: 1 });
    prisma.monthlyPerformanceGroupMember.createMany.mockResolvedValue({ count: 1 });

    await performanceGroups.update(
      'group-1',
      {
        settlementMonth: '2026-06-01',
        members: [{ employeeId: 'emp-1', allocationRatio: '1' }],
      },
      actor,
    );

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.monthlyPerformanceGroup.update).toHaveBeenCalledWith({
      where: { id: 'group-1' },
      data: { settlementMonth: newSettlementMonth },
    });
    expect(prisma.monthlyPerformanceGroupMember.createMany).toHaveBeenCalledWith({
      data: [
        {
          settlementMonth: newSettlementMonth,
          groupId: 'group-1',
          employeeId: 'emp-1',
          allocationRatio: expect.any(Prisma.Decimal),
        },
      ],
    });
  });

  it('maps duplicate salary item config code to DUPLICATE_RESOURCE', async () => {
    const { salaryItemConfigs, prisma } = createHarness();
    prisma.salaryItemConfig.create.mockRejectedValue(duplicateError());

    await expect(
      salaryItemConfigs.create(
        { code: 'living_allowance', name: 'Living allowance', itemType: SalaryItemType.addition },
        actor,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.DUPLICATE_RESOURCE });
  });

  it('rejects negative monthly salary manual item amountRmb', async () => {
    const { monthlySalaryManualItems } = createHarness();

    await expect(
      monthlySalaryManualItems.create(
        { settlementMonth: '2026-05-01', employeeId: 'emp-1', configId: 'config-1', amountRmb: '-0.01' },
        actor,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
  });

  it('blocks monthly salary manual item update and disable for locked months', async () => {
    const { monthlySalaryManualItems, prisma, monthLock, audit } = createHarness();
    const lockedError = new AppError(ERROR_CODES.MONTH_LOCKED, 'locked');
    prisma.monthlySalaryManualItem.findUnique.mockResolvedValue({
      id: 'item-1',
      settlementMonth,
      employeeId: 'emp-1',
      configId: 'config-1',
      amountRmb: new Prisma.Decimal('100'),
      status: CommonStatus.active,
    });

    monthLock.assertWritable.mockRejectedValueOnce(lockedError);
    await expect(monthlySalaryManualItems.update('item-1', { amountRmb: '200' }, actor)).rejects.toBe(lockedError);

    monthLock.assertWritable.mockRejectedValueOnce(lockedError);
    await expect(monthlySalaryManualItems.disable('item-1', actor)).rejects.toBe(lockedError);

    expect(prisma.monthlySalaryManualItem.update).not.toHaveBeenCalled();
    expect(audit.failure).not.toHaveBeenCalled();
  });

  it('disables without physical delete by updating status', async () => {
    const { historicalNegativeProfits, prisma, audit } = createHarness();
    prisma.historicalNegativeProfit.findUnique.mockResolvedValue({
      id: 'profit-1',
      settlementMonth,
      status: CommonStatus.active,
    });
    prisma.historicalNegativeProfit.update.mockResolvedValue({
      id: 'profit-1',
      settlementMonth,
      status: CommonStatus.disabled,
    });

    await historicalNegativeProfits.disable('profit-1', actor);

    expect(prisma.historicalNegativeProfit.update).toHaveBeenCalledWith({
      where: { id: 'profit-1' },
      data: { status: CommonStatus.disabled },
    });
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'historical_negative_profit.disable',
        changedFields: ['status'],
      }),
    );
  });

  it('rejects non-month-start settlementMonth', async () => {
    const { manualIncome } = createHarness();

    await expect(
      manualIncome.create({ settlementMonth: '2026-05-15', source: 'manual', incomeUsd: '1' }, actor),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
  });
});
