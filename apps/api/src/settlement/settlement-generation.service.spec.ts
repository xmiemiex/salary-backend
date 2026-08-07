import {
  AttendanceStatus,
  CommonStatus,
  Prisma,
  Provider,
  SalaryItemType,
  SalaryMode,
  SettlementStatus,
} from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { MonthLockService } from '../month-lock/month-lock.service';
import { SettlementCalculatorService } from './settlement-calculator.service';
import { SettlementGenerationService } from './settlement-generation.service';
import { SettlementPreflightResult, SettlementPreflightService } from './settlement-preflight.service';

describe('SettlementGenerationService', () => {
  const settlementMonth = new Date('2026-05-01T00:00:00.000Z');
  const actor = { userId: 'user-1', roleCode: 'finance' };

  function decimal(value: string) {
    return new Prisma.Decimal(value);
  }

  function calculationResult(employeeId = 'emp-1') {
    return {
      employeeId,
      settlementMonth,
      salaryMode: SalaryMode.single,
      totalRevenueUsd: decimal('10000'),
      apiCardSpendUsd: decimal('1000'),
      apiCardFeeUsd: decimal('30'),
      manualCardSpendUsd: decimal('200'),
      finalCardSpendUsd: decimal('1230'),
      originalProfitUsd: decimal('8770'),
      groupId: null,
      allocationRatio: null,
      allocatedProfitUsd: decimal('8770'),
      historicalNegativeProfitUsd: decimal('1000'),
      commissionProfitUsd: decimal('7770'),
      remainingNegativeProfitUsd: decimal('0'),
      baseSalaryRmb: decimal('3000'),
      starAllowanceRmb: decimal('500'),
      commissionRate: decimal('0.06'),
      commissionUsd: decimal('466.2'),
      exchangeRate: decimal('7.1'),
      commissionRmb: decimal('3309.02'),
      attendanceStatus: AttendanceStatus.full_attendance,
      attendanceBonusRmb: decimal('500'),
      manualAdditionRmb: decimal('100'),
      manualDeductionRmb: decimal('50'),
      finalSalaryRmb: decimal('7359.02'),
      snapshot: { fromCalculator: true },
    };
  }

  function createHarness(overrides: {
    exchangeRate?: unknown;
    incomeRecords?: unknown[];
    apiCardSpendEvents?: unknown[];
    manualCardSpendEntries?: unknown[];
    cardProviderFeeRates?: unknown[];
    groupMembers?: unknown[];
    historicalNegativeProfits?: unknown[];
    salaryManualItems?: unknown[];
    calculationResults?: unknown[];
    existingSettlement?: unknown;
    assertWritableError?: unknown;
    preflightResult?: SettlementPreflightResult;
  } = {}) {
    const tx = {
      monthlySettlement: {
        findUnique: jest.fn().mockResolvedValue(overrides.existingSettlement ?? null),
        upsert: jest.fn().mockResolvedValue({
          id: 'settlement-1',
          settlementMonth,
          status: SettlementStatus.draft,
        }),
      },
      monthlySettlementDetail: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const prisma = {
      monthlyExchangeRate: {
        findFirst: jest.fn().mockResolvedValue(
          overrides.exchangeRate === undefined
            ? { usdToRmbRate: decimal('7.1') }
            : overrides.exchangeRate,
        ),
      },
      incomeRecord: {
        findMany: jest.fn().mockResolvedValue(
          overrides.incomeRecords ?? [
            { employeeId: 'emp-1', incomeUsd: decimal('10000'), status: CommonStatus.confirmed },
          ],
        ),
      },
      cardSpendEvent: {
        findMany: jest.fn().mockResolvedValue(
          overrides.apiCardSpendEvents ?? [
            {
              employeeId: 'emp-1',
              provider: Provider.airwallex,
              spendUsd: decimal('1000'),
              status: CommonStatus.confirmed,
            },
          ],
        ),
      },
      manualCardSpendEntry: {
        findMany: jest.fn().mockResolvedValue(
          overrides.manualCardSpendEntries ?? [
            {
              employeeId: 'emp-1',
              actualSpendUsd: decimal('200'),
              status: SettlementStatus.confirmed,
            },
          ],
        ),
      },
      monthlyCardProviderFeeRate: {
        findMany: jest.fn().mockResolvedValue(
          overrides.cardProviderFeeRates ?? [
            { provider: Provider.airwallex, feeRate: decimal('0.03') },
          ],
        ),
      },
      monthlyPerformanceGroupMember: {
        findMany: jest.fn().mockResolvedValue(
          overrides.groupMembers ?? [
            { groupId: 'group-1', employeeId: 'emp-1', allocationRatio: decimal('1') },
          ],
        ),
      },
      historicalNegativeProfit: {
        findMany: jest.fn().mockResolvedValue(
          overrides.historicalNegativeProfits ?? [
            { employeeId: 'emp-1', amountUsd: decimal('1000'), status: CommonStatus.active },
          ],
        ),
        create: jest.fn(),
        upsert: jest.fn(),
      },
      monthlySalaryManualItem: {
        findMany: jest.fn().mockResolvedValue(
          overrides.salaryManualItems ?? [
            {
              employeeId: 'emp-1',
              amountRmb: decimal('100'),
              status: CommonStatus.active,
              config: { itemType: SalaryItemType.addition, code: 'bonus', name: 'Bonus' },
            },
          ],
        ),
      },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };

    const monthLock = {
      assertWritable: jest.fn().mockImplementation(async () => {
        if (overrides.assertWritableError) {
          throw overrides.assertWritableError;
        }
      }),
    };
    const audit = {
      success: jest.fn().mockResolvedValue(undefined),
      failure: jest.fn().mockResolvedValue(undefined),
    };
    const calculator = {
      calculate: jest.fn().mockReturnValue(overrides.calculationResults ?? [calculationResult()]),
    };
    const preflight = {
      assertCanGenerate: jest.fn().mockImplementation(async (_month: Date, acknowledgedWarningCodes?: unknown) => {
        const result = overrides.preflightResult ?? preflightResult('ok');
        if (!result.canGenerate || result.severity === 'blocking') {
          throw new AppError(
            ERROR_CODES.SETTLEMENT_PRECHECK_FAILED,
            'Settlement generation is blocked by preflight checks.',
            {
              settlementMonth: result.settlementMonth,
              severity: result.severity,
              blockingChecks: result.checks
                .filter((check) => check.severity === 'blocking')
                .map(({ code, message }) => ({ code, message })),
            },
          );
        }
        const required = result.checks.filter((check) => check.severity === 'warning').map((check) => check.code);
        const acknowledged = Array.isArray(acknowledgedWarningCodes)
          ? acknowledgedWarningCodes.filter((code): code is string => typeof code === 'string')
          : [];
        const missing = required.filter((code) => !acknowledged.includes(code));
        const unknown = acknowledged.filter((code) => !required.includes(code));
        if (
          (acknowledgedWarningCodes !== undefined && !Array.isArray(acknowledgedWarningCodes))
          || acknowledged.some((code) => !code.trim())
          || (Array.isArray(acknowledgedWarningCodes) && acknowledged.length !== acknowledgedWarningCodes.length)
          || new Set(acknowledged).size !== acknowledged.length
          || missing.length
          || unknown.length
        ) {
          throw new AppError(ERROR_CODES.SETTLEMENT_WARNING_ACK_REQUIRED, 'Warnings must be acknowledged.', {
            settlementMonth: result.settlementMonth,
            requiredWarningCodes: required,
            acknowledgedWarningCodes: acknowledged,
            missingWarningCodes: missing,
            unknownWarningCodes: unknown,
          });
        }
        return result;
      }),
    };

    return {
      service: new SettlementGenerationService(
        prisma as never,
        monthLock as unknown as MonthLockService,
        audit as unknown as AuditService,
        calculator as unknown as SettlementCalculatorService,
        preflight as unknown as SettlementPreflightService,
      ),
      prisma,
      tx,
      monthLock,
      audit,
      calculator,
      preflight,
    };
  }

  function preflightResult(severity: 'ok' | 'warning' | 'blocking', canGenerate = severity !== 'blocking'):
    SettlementPreflightResult {
    return {
      settlementMonth: '2026-05-01',
      canGenerate,
      severity,
      checks: severity === 'ok' ? [] : [{
        code: severity === 'blocking' ? 'TEST_BLOCKER' : 'TEST_WARNING',
        severity,
        message: severity === 'blocking' ? 'Generation is blocked.' : 'Review recommended.',
      }],
      summary: {
        openUnmatchedEventCount: 0,
        missingProviderFeeRateCount: 0,
        missingExchangeRate: false,
        draftManualRecordCount: 0,
        runningOrPendingSyncTaskCount: 0,
        staleCakeAdjustmentCount: 0,
        isLocked: false,
      },
    };
  }

  it('generates settlement, reads monthly data, writes details, and audits success', async () => {
    const { service, prisma, tx, monthLock, audit, calculator, preflight } = createHarness();

    await expect(service.generateSettlement({ settlementMonth, actor })).resolves.toEqual({
      settlementId: 'settlement-1',
      settlementMonth,
      detailCount: 1,
    });

    expect(monthLock.assertWritable).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementMonth,
        action: 'settlement.generate',
        objectType: 'monthly_settlements',
      }),
      actor,
    );
    expect(preflight.assertCanGenerate).toHaveBeenCalledWith(settlementMonth, undefined);
    expect(prisma.monthlyExchangeRate.findFirst).toHaveBeenCalledWith({
      where: { settlementMonth, status: { in: [CommonStatus.active, CommonStatus.confirmed] } },
      select: { usdToRmbRate: true },
    });
    expect(prisma.incomeRecord.findMany).toHaveBeenCalledWith({
      where: { settlementMonth, status: CommonStatus.confirmed },
      select: { employeeId: true, incomeUsd: true, status: true },
    });
    expect(prisma.cardSpendEvent.findMany).toHaveBeenCalledWith({
      where: { settlementMonth, status: CommonStatus.confirmed },
      select: { employeeId: true, provider: true, spendUsd: true, status: true },
    });
    expect(prisma.manualCardSpendEntry.findMany).toHaveBeenCalled();
    expect(prisma.monthlyCardProviderFeeRate.findMany).toHaveBeenCalled();
    expect(prisma.monthlyPerformanceGroupMember.findMany).toHaveBeenCalled();
    expect(prisma.historicalNegativeProfit.findMany).toHaveBeenCalled();
    expect(prisma.monthlySalaryManualItem.findMany).toHaveBeenCalled();

    expect(calculator.calculate).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementMonth,
        exchangeRate: decimal('7.1'),
        employeeIds: expect.arrayContaining(['emp-1']),
      }),
    );
    expect(tx.monthlySettlement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { settlementMonth },
        create: expect.objectContaining({ status: SettlementStatus.draft, generatedBy: actor.userId }),
      }),
    );
    expect(tx.monthlySettlementDetail.deleteMany).toHaveBeenCalledWith({
      where: { settlementId: 'settlement-1' },
    });
    expect(tx.monthlySettlementDetail.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          settlementId: 'settlement-1',
          employeeId: 'emp-1',
          incomeUsd: decimal('10000'),
          cardSpendUsd: decimal('1230'),
          grossProfitUsd: decimal('8770'),
          finalSalaryRmb: decimal('7359.02'),
        }),
      ]),
    });
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settlement.generate',
        objectType: 'monthly_settlement',
        objectId: 'settlement-1',
        settlementMonth,
        afterData: expect.objectContaining({
          settlementId: 'settlement-1',
          detailCount: 1,
          preflight: expect.objectContaining({
            settlementMonth: '2026-05-01',
            severity: 'ok',
            canGenerate: true,
            acknowledgedWarningCodes: [],
          }),
        }),
        requestPayload: expect.objectContaining({
          acknowledgedWarningCodeCount: 0,
          hasWarningAcknowledgement: false,
        }),
      }),
      tx,
    );
  });

  it('rejects preflight blocking before calculation or settlement writes', async () => {
    const { service, prisma, tx, monthLock, audit, calculator } = createHarness({
      preflightResult: preflightResult('blocking'),
    });

    await expect(service.generateSettlement({ settlementMonth, actor })).rejects.toMatchObject({
      code: ERROR_CODES.SETTLEMENT_PRECHECK_FAILED,
    });

    expect(monthLock.assertWritable).not.toHaveBeenCalled();
    expect(prisma.monthlyExchangeRate.findFirst).not.toHaveBeenCalled();
    expect(calculator.calculate).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.monthlySettlement.upsert).not.toHaveBeenCalled();
    expect(tx.monthlySettlementDetail.deleteMany).not.toHaveBeenCalled();
    expect(tx.monthlySettlementDetail.createMany).not.toHaveBeenCalled();
    expect(audit.success).not.toHaveBeenCalled();
    expect(audit.failure).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: ERROR_CODES.SETTLEMENT_PRECHECK_FAILED }),
    );
  });

  it('rejects canGenerate=false even when severity is warning', async () => {
    const { service, prisma } = createHarness({
      preflightResult: preflightResult('warning', false),
    });

    await expect(service.generateSettlement({ settlementMonth, actor })).rejects.toMatchObject({
      code: ERROR_CODES.SETTLEMENT_PRECHECK_FAILED,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows warning preflight results after exact acknowledgement', async () => {
    const warningResult = preflightResult('warning');
    warningResult.checks[0] = {
      ...warningResult.checks[0],
      count: 2,
      amountUsd: '12.34',
      details: {
        apiKey: 'sensitive-api-key',
        token: 'sensitive-token',
        secret: 'sensitive-secret',
        Authorization: 'Bearer sensitive-credential',
      },
    };
    const { service, tx, audit } = createHarness({ preflightResult: warningResult });

    await expect(service.generateSettlement({
      settlementMonth,
      actor,
      acknowledgedWarningCodes: ['TEST_WARNING'],
    })).resolves.toEqual(
      expect.objectContaining({ settlementId: 'settlement-1' }),
    );
    expect(tx.monthlySettlement.upsert).toHaveBeenCalled();
    const successAudit = audit.success.mock.calls[0][0];
    expect(successAudit.afterData.preflight).toEqual({
      settlementMonth: '2026-05-01',
      severity: 'warning',
      canGenerate: true,
      checks: [{
        code: 'TEST_WARNING',
        severity: 'warning',
        message: 'Review recommended.',
        count: 2,
        amountUsd: '12.34',
      }],
      summary: warningResult.summary,
      acknowledgedWarningCodes: ['TEST_WARNING'],
    });
    expect(successAudit.requestPayload).toEqual(expect.objectContaining({
      acknowledgedWarningCodeCount: 1,
      hasWarningAcknowledgement: true,
    }));
    expect(JSON.stringify(successAudit.afterData.preflight)).not.toMatch(
      /details|sensitive-api-key|sensitive-token|sensitive-secret|sensitive-credential/,
    );
  });

  it('does not write raw malicious warning acknowledgement values to failure audit', async () => {
    const maliciousCode = 'EVIL_TOKEN_<script>alert(1)</script>';
    const { service, audit } = createHarness({ preflightResult: preflightResult('warning') });

    await expect(service.generateSettlement({
      settlementMonth,
      actor,
      acknowledgedWarningCodes: ['TEST_WARNING', maliciousCode],
    })).rejects.toMatchObject({ code: ERROR_CODES.SETTLEMENT_WARNING_ACK_REQUIRED });

    expect(audit.success).not.toHaveBeenCalled();
    expect(audit.failure).toHaveBeenCalledWith(expect.objectContaining({
      failureReason: ERROR_CODES.SETTLEMENT_WARNING_ACK_REQUIRED,
      requestPayload: expect.objectContaining({
        acknowledgedWarningCodeCount: 2,
        hasWarningAcknowledgement: true,
      }),
    }));
    expect(JSON.stringify(audit.failure.mock.calls)).not.toContain(maliciousCode);
    expect(JSON.stringify(audit.failure.mock.calls)).not.toContain('acknowledgedWarningCodes');
  });

  it.each([
    ['missing code', []],
    ['unknown code', ['TEST_WARNING', 'STALE_WARNING']],
    ['duplicate code', ['TEST_WARNING', 'TEST_WARNING']],
    ['empty code', ['TEST_WARNING', '']],
    ['non-string code', ['TEST_WARNING', 42]],
  ])('rejects warning acknowledgement with %s before calculation or writes', async (_label, codes) => {
    const { service, prisma, tx, calculator } = createHarness({ preflightResult: preflightResult('warning') });

    const promise = service.generateSettlement({ settlementMonth, actor, acknowledgedWarningCodes: codes });
    await expect(promise).rejects.toMatchObject({ code: ERROR_CODES.SETTLEMENT_WARNING_ACK_REQUIRED });
    await promise.catch((error: AppError) => {
      expect(Object.keys((error.getResponse() as { details: object }).details).sort()).toEqual([
        'acknowledgedWarningCodes',
        'missingWarningCodes',
        'requiredWarningCodes',
        'settlementMonth',
        'unknownWarningCodes',
      ]);
      expect(JSON.stringify((error.getResponse() as { details: object }).details)).not.toMatch(
        /severity|blockingChecks|checks|summary|apiKey|token|secret/,
      );
    });
    expect(prisma.monthlyExchangeRate.findFirst).not.toHaveBeenCalled();
    expect(calculator.calculate).not.toHaveBeenCalled();
    expect(tx.monthlySettlement.upsert).not.toHaveBeenCalled();
  });

  it('keeps blocking precedence even when warning acknowledgement is supplied', async () => {
    const { service, calculator, tx } = createHarness({ preflightResult: preflightResult('blocking') });
    await expect(service.generateSettlement({
      settlementMonth,
      actor,
      acknowledgedWarningCodes: ['TEST_BLOCKER'],
    })).rejects.toMatchObject({ code: ERROR_CODES.SETTLEMENT_PRECHECK_FAILED });
    expect(calculator.calculate).not.toHaveBeenCalled();
    expect(tx.monthlySettlement.upsert).not.toHaveBeenCalled();
  });

  it('rejects locked month without writing settlement/details or duplicate generation failure audit', async () => {
    const lockedError = new AppError(ERROR_CODES.MONTH_LOCKED, 'locked');
    const { service, tx, audit } = createHarness({ assertWritableError: lockedError });

    await expect(service.generateSettlement({ settlementMonth, actor })).rejects.toBe(lockedError);

    expect(tx.monthlySettlement.upsert).not.toHaveBeenCalled();
    expect(tx.monthlySettlementDetail.deleteMany).not.toHaveBeenCalled();
    expect(tx.monthlySettlementDetail.createMany).not.toHaveBeenCalled();
    expect(audit.failure).not.toHaveBeenCalled();
  });

  it('fails and audits when monthly exchange rate is missing', async () => {
    const { service, audit } = createHarness({ exchangeRate: null });

    await expect(service.generateSettlement({ settlementMonth, actor })).rejects.toBeInstanceOf(AppError);

    expect(audit.failure).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settlement.generate',
        failureReason: ERROR_CODES.SETTLEMENT_PRECHECK_FAILED,
      }),
    );
  });

  it('fails and audits when confirmed income has no employee', async () => {
    const { service, audit } = createHarness({
      incomeRecords: [{ employeeId: null, incomeUsd: decimal('100'), status: CommonStatus.confirmed }],
    });

    await expect(service.generateSettlement({ settlementMonth, actor })).rejects.toBeInstanceOf(AppError);

    expect(audit.failure).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: ERROR_CODES.SETTLEMENT_PRECHECK_FAILED }),
    );
  });

  it('fails and audits when confirmed API card spend misses provider fee rate', async () => {
    const { service, audit } = createHarness({ cardProviderFeeRates: [] });

    await expect(service.generateSettlement({ settlementMonth, actor })).rejects.toBeInstanceOf(AppError);

    expect(audit.failure).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: ERROR_CODES.SETTLEMENT_PRECHECK_FAILED }),
    );
  });

  it('recalculates unlocked month by deleting old details and recreating only current employees', async () => {
    const { service, tx } = createHarness({
      existingSettlement: { id: 'settlement-1', settlementMonth, status: SettlementStatus.confirmed },
      calculationResults: [calculationResult('emp-new')],
    });

    await service.generateSettlement({ settlementMonth, actor });

    expect(tx.monthlySettlementDetail.deleteMany).toHaveBeenCalledWith({
      where: { settlementId: 'settlement-1' },
    });
    expect(tx.monthlySettlementDetail.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ employeeId: 'emp-new' })],
    });
  });

  it('writes required snapshot fields and card spend settlement month rule', async () => {
    const { service, tx } = createHarness();

    await service.generateSettlement({ settlementMonth, actor });

    const createManyArg = tx.monthlySettlementDetail.createMany.mock.calls[0][0];
    const snapshot = createManyArg.data[0].snapshot;

    expect(snapshot).toEqual(
      expect.objectContaining({
        salaryMode: SalaryMode.single,
        exchangeRate: '7.1',
        commissionProfitUsd: '7770',
        remainingNegativeProfitUsd: '0',
        apiCardFeeUsd: '30',
        cardSpendSettlementMonthRule:
          'card_spend_events.settlement_month is based on transaction time in GMT+8, not settled_at',
      }),
    );
  });

  it('does not write next month historical negative profits during generation', async () => {
    const { service, prisma } = createHarness();

    await service.generateSettlement({ settlementMonth, actor });

    expect(prisma.historicalNegativeProfit.create).not.toHaveBeenCalled();
    expect(prisma.historicalNegativeProfit.upsert).not.toHaveBeenCalled();
  });

  it('documents delayed virtual card settlement by querying confirmed settlement_month only, not settled_at', async () => {
    const { service, prisma, tx } = createHarness();

    await service.generateSettlement({ settlementMonth, actor });

    expect(prisma.cardSpendEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { settlementMonth, status: CommonStatus.confirmed },
      }),
    );
    expect(prisma.cardSpendEvent.findMany.mock.calls[0][0].where).not.toHaveProperty('settledAt');

    const snapshot = tx.monthlySettlementDetail.createMany.mock.calls[0][0].data[0].snapshot;
    expect(snapshot.cardSpendSettlementMonthRule).toBe(
      'card_spend_events.settlement_month is based on transaction time in GMT+8, not settled_at',
    );
  });
});
