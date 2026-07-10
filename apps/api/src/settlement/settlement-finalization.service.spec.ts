import { CommonStatus, Prisma, SettlementStatus } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { MonthLockService } from '../month-lock/month-lock.service';
import { SettlementFinalizationService } from './settlement-finalization.service';

describe('SettlementFinalizationService', () => {
  const settlementMonth = new Date('2026-05-01T00:00:00.000Z');
  const nextMonth = new Date('2026-06-01T00:00:00.000Z');
  const actor = { userId: '00000000-0000-0000-0000-000000000001', roleCode: 'finance' };

  function decimal(value: string) {
    return new Prisma.Decimal(value);
  }

  function detail(overrides: Record<string, unknown> = {}) {
    return {
      id: 'detail-1',
      settlementId: 'settlement-1',
      employeeId: 'emp-1',
      settlementMonth,
      attendanceStatus: 'full_attendance',
      incomeUsd: decimal('10000'),
      cardSpendUsd: decimal('4000'),
      grossProfitUsd: decimal('6000'),
      grossProfitRmb: decimal('42000'),
      commissionRmb: decimal('2520'),
      manualAdditionRmb: decimal('100'),
      manualDeductionRmb: decimal('50'),
      finalSalaryRmb: decimal('6570'),
      snapshot: {
        commissionProfitUsd: '6000',
        remainingNegativeProfitUsd: '6000',
        baseSalaryRmb: '3000',
        starAllowanceRmb: '500',
        commissionRate: '0.06',
        commissionUsd: '360',
        attendanceBonusRmb: '500',
        salaryMode: 'single',
        groupId: 'group,1',
      },
      createdAt: new Date('2026-05-02T00:00:00.000Z'),
      updatedAt: new Date('2026-05-02T00:00:00.000Z'),
      ...overrides,
    };
  }

  function settlement(status: SettlementStatus, details = [detail()]) {
    return {
      id: 'settlement-1',
      settlementMonth,
      status,
      generatedAt: new Date('2026-05-02T00:00:00.000Z'),
      generatedBy: actor.userId,
      confirmedAt: null,
      confirmedBy: null,
      lockedAt: null,
      lockedBy: null,
      lockReason: null,
      createdAt: new Date('2026-05-02T00:00:00.000Z'),
      updatedAt: new Date('2026-05-02T00:00:00.000Z'),
      details,
    };
  }

  function createHarness(overrides: {
    monthlySettlement?: unknown;
    existingHistoricalNegativeProfit?: unknown;
  } = {}) {
    const monthlySettlement = Object.prototype.hasOwnProperty.call(overrides, 'monthlySettlement')
      ? overrides.monthlySettlement
      : settlement(SettlementStatus.confirmed);
    const txMonthlySettlement = Object.prototype.hasOwnProperty.call(overrides, 'monthlySettlement')
      ? overrides.monthlySettlement
      : settlement(SettlementStatus.draft);
    const tx = {
      monthlySettlement: {
        findUnique: jest.fn().mockResolvedValue(txMonthlySettlement),
        update: jest.fn().mockResolvedValue({
          ...settlement(SettlementStatus.confirmed),
          details: undefined,
          status: SettlementStatus.confirmed,
          confirmedAt: new Date('2026-05-03T00:00:00.000Z'),
          confirmedBy: actor.userId,
        }),
      },
      historicalNegativeProfit: {
        findFirst: jest.fn().mockResolvedValue(overrides.existingHistoricalNegativeProfit ?? null),
        create: jest.fn().mockResolvedValue({ id: 'profit-1' }),
        update: jest.fn().mockResolvedValue({ id: 'profit-1' }),
      },
      auditLog: { create: jest.fn() },
    };

    const prisma = {
      monthlySettlement: {
        findUnique: jest.fn().mockResolvedValue(monthlySettlement),
      },
      monthlySettlementDetail: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([detail()]),
      },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const monthLock = {
      lockMonth: jest.fn().mockResolvedValue({
        ...settlement(SettlementStatus.locked),
        details: undefined,
        status: SettlementStatus.locked,
      }),
    };
    const audit = {
      success: jest.fn().mockResolvedValue(undefined),
      failure: jest.fn().mockResolvedValue(undefined),
    };

    return {
      service: new SettlementFinalizationService(
        prisma as never,
        monthLock as unknown as MonthLockService,
        audit as unknown as AuditService,
      ),
      prisma,
      tx,
      monthLock,
      audit,
    };
  }

  it('confirms draft settlement with details and writes success audit', async () => {
    const { service, tx, audit } = createHarness({
      monthlySettlement: settlement(SettlementStatus.draft),
    });

    await expect(service.confirmSettlement(settlementMonth, actor)).resolves.toEqual(
      expect.objectContaining({ status: SettlementStatus.confirmed, confirmedBy: actor.userId }),
    );

    expect(tx.monthlySettlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'settlement-1' },
        data: expect.objectContaining({ status: SettlementStatus.confirmed, confirmedBy: actor.userId }),
      }),
    );
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settlement.confirm',
        objectType: 'monthly_settlement',
        settlementMonth,
        changedFields: ['status', 'confirmedAt', 'confirmedBy'],
      }),
      tx,
    );
  });

  it('rejects confirm when settlement does not exist', async () => {
    const { service } = createHarness({ monthlySettlement: null });

    await expect(service.confirmSettlement(settlementMonth, actor)).rejects.toMatchObject({
      code: ERROR_CODES.SETTLEMENT_NOT_FOUND,
    });
  });

  it.each([SettlementStatus.confirmed, SettlementStatus.locked])(
    'rejects confirm when settlement is %s',
    async (status) => {
      const { service } = createHarness({ monthlySettlement: settlement(status) });

      await expect(service.confirmSettlement(settlementMonth, actor)).rejects.toMatchObject({
        code: ERROR_CODES.CONFLICT,
      });
    },
  );

  it('rejects confirm when settlement has no details', async () => {
    const { service } = createHarness({ monthlySettlement: settlement(SettlementStatus.draft, []) });

    await expect(service.confirmSettlement(settlementMonth, actor)).rejects.toMatchObject({
      code: ERROR_CODES.SETTLEMENT_PRECHECK_FAILED,
    });
  });

  it('locks confirmed settlement by delegating to MonthLockService and rolling forward negatives', async () => {
    const { service, monthLock, tx } = createHarness({
      monthlySettlement: settlement(SettlementStatus.confirmed),
    });

    await service.lockSettlement(settlementMonth, actor, { lockReason: 'month close' });

    expect(monthLock.lockMonth).toHaveBeenCalledWith(settlementMonth, actor, 'month close');
    expect(tx.historicalNegativeProfit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        settlementMonth: nextMonth,
        employeeId: 'emp-1',
        amountUsd: decimal('6000'),
        reason: 'Auto roll-forward from locked settlement 2026-05',
        status: CommonStatus.active,
        createdBy: actor.userId,
      }),
    });
  });

  it('rejects draft settlement lock before calling MonthLockService', async () => {
    const { service, monthLock } = createHarness({
      monthlySettlement: settlement(SettlementStatus.draft),
    });

    await expect(service.lockSettlement(settlementMonth, actor, { lockReason: 'close' })).rejects.toMatchObject({
      code: ERROR_CODES.SETTLEMENT_PRECHECK_FAILED,
    });
    expect(monthLock.lockMonth).not.toHaveBeenCalled();
  });

  it('does not create historical negative profit when remaining negative profit is zero', async () => {
    const { service, tx } = createHarness({
      monthlySettlement: settlement(SettlementStatus.confirmed, [
        detail({ snapshot: { remainingNegativeProfitUsd: '0' } }),
      ]),
    });

    await service.lockSettlement(settlementMonth, actor, { lockReason: 'close' });

    expect(tx.historicalNegativeProfit.create).not.toHaveBeenCalled();
    expect(tx.historicalNegativeProfit.update).not.toHaveBeenCalled();
  });

  it('updates existing roll-forward record instead of creating a duplicate', async () => {
    const { service, tx } = createHarness({
      monthlySettlement: settlement(SettlementStatus.confirmed),
      existingHistoricalNegativeProfit: { id: 'profit-existing' },
    });

    await service.lockSettlement(settlementMonth, actor, { lockReason: 'close' });

    expect(tx.historicalNegativeProfit.update).toHaveBeenCalledWith({
      where: { id: 'profit-existing' },
      data: { amountUsd: decimal('6000') },
    });
    expect(tx.historicalNegativeProfit.create).not.toHaveBeenCalled();
  });

  it('exports CSV with header, detail fields, snapshot fields, escaping, and audit', async () => {
    const { service, audit } = createHarness({
      monthlySettlement: settlement(SettlementStatus.confirmed, [
        detail({ snapshot: { ...detail().snapshot, groupId: 'group,"A"\nline' } }),
      ]),
    });

    const csv = await service.exportSettlementCsv(settlementMonth, actor);

    expect(csv).toContain('settlement_month,employee_id,income_usd');
    expect(csv).toContain('2026-05,emp-1,10000,4000,6000,6000,6000,3000,500,0.06,360,2520,500,100,50,6570,single');
    expect(csv).toContain('"group,""A""\nline"');
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'salary.export',
        objectType: 'monthly_settlement',
        settlementMonth,
        afterData: expect.objectContaining({ detailCount: 1 }),
      }),
    );
  });

  it('writes roll-forward success audit', async () => {
    const { service, audit } = createHarness({
      monthlySettlement: settlement(SettlementStatus.confirmed),
    });

    await service.lockSettlement(settlementMonth, actor, { lockReason: 'close' });

    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'historical_negative_profit.roll_forward',
        afterData: expect.objectContaining({ nextMonth: '2026-06', createdCount: 1, updatedCount: 0 }),
      }),
      expect.anything(),
    );
  });
});
