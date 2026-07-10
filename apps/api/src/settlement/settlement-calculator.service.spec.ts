import {
  AttendanceStatus,
  CommonStatus,
  Provider,
  SalaryItemType,
  SalaryMode,
  SettlementStatus,
} from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../common/app-error';
import {
  SettlementCalculationInput,
  SettlementCalculatorService,
  applyNegativeCarryover,
  calculateSalaryTier,
} from './settlement-calculator.service';

describe('SettlementCalculatorService', () => {
  const settlementMonth = new Date('2026-05-01T00:00:00.000Z');
  const service = new SettlementCalculatorService();

  function calculate(input: Partial<SettlementCalculationInput> = {}) {
    return service.calculate({
      settlementMonth,
      exchangeRate: '6.8',
      ...input,
    });
  }

  function employeeProfit(employeeId: string, profitUsd: string) {
    return {
      employeeId,
      incomeUsd: profitUsd,
      status: CommonStatus.confirmed,
    };
  }

  function expectDecimal(value: { toString(): string }, expected: string) {
    expect(value.toString()).toBe(expected);
  }

  it('calculates single employee commission for profit 10000 and exchange rate 6.8', () => {
    const [result] = calculate({
      incomeRecords: [employeeProfit('SUB1', '10000')],
    });

    expect(result.salaryMode).toBe(SalaryMode.single);
    expectDecimal(result.commissionRate, '0.06');
    expectDecimal(result.commissionUsd, '600');
    expectDecimal(result.commissionRmb, '4080');
  });

  it('uses minimum single salary tier when profit is below 3000', () => {
    const tier = calculateSalaryTier('2999.99', SalaryMode.single);

    expectDecimal(tier.baseSalaryRmb, '2500');
    expectDecimal(tier.starAllowanceRmb, '0');
    expectDecimal(tier.commissionRate, '0');
  });

  it('uses single 3000-4999 salary tier', () => {
    const tier = calculateSalaryTier('3000', SalaryMode.single);

    expectDecimal(tier.baseSalaryRmb, '3000');
    expectDecimal(tier.starAllowanceRmb, '300');
    expectDecimal(tier.commissionRate, '0.04');
  });

  it('uses group 3000-4999 salary tier without star allowance or commission', () => {
    const tier = calculateSalaryTier('4999', SalaryMode.group);

    expectDecimal(tier.baseSalaryRmb, '3000');
    expectDecimal(tier.starAllowanceRmb, '0');
    expectDecimal(tier.commissionRate, '0');
  });

  it('allocates 50/50 group profit', () => {
    const results = calculate({
      incomeRecords: [employeeProfit('SUB1', '5000'), employeeProfit('SUB2', '8000')],
      groupMembers: [
        { groupId: 'G1', employeeId: 'SUB1', allocationRatio: '0.5' },
        { groupId: 'G1', employeeId: 'SUB2', allocationRatio: '0.5' },
      ],
    });

    expectDecimal(results.find((result) => result.employeeId === 'SUB1')!.allocatedProfitUsd, '6500');
    expectDecimal(results.find((result) => result.employeeId === 'SUB2')!.allocatedProfitUsd, '6500');
  });

  it('allocates 1:9 group profit', () => {
    const results = calculate({
      incomeRecords: [employeeProfit('SUB1', '5000'), employeeProfit('SUB2', '8000')],
      groupMembers: [
        { groupId: 'G1', employeeId: 'SUB1', allocationRatio: '0.1' },
        { groupId: 'G1', employeeId: 'SUB2', allocationRatio: '0.9' },
      ],
    });

    expectDecimal(results.find((result) => result.employeeId === 'SUB1')!.allocatedProfitUsd, '1300');
    expectDecimal(results.find((result) => result.employeeId === 'SUB2')!.allocatedProfitUsd, '11700');
  });

  it('applies personal negative carryover after group allocation', () => {
    const results = calculate({
      incomeRecords: [employeeProfit('SUB1', '4000'), employeeProfit('SUB2', '4000')],
      groupMembers: [
        { groupId: 'G1', employeeId: 'SUB1', allocationRatio: '0.5' },
        { groupId: 'G1', employeeId: 'SUB2', allocationRatio: '0.5' },
      ],
      historicalNegativeProfits: [
        { employeeId: 'SUB2', amountUsd: '10000', status: CommonStatus.active },
      ],
    });

    const sub1 = results.find((result) => result.employeeId === 'SUB1')!;
    const sub2 = results.find((result) => result.employeeId === 'SUB2')!;

    expectDecimal(sub1.commissionProfitUsd, '4000');
    expectDecimal(sub2.commissionProfitUsd, '0');
    expectDecimal(sub2.remainingNegativeProfitUsd, '6000');
  });

  it('keeps rolling negative profit when current profit is not enough', () => {
    const result = applyNegativeCarryover('3000', '10000');

    expectDecimal(result.remainingNegativeProfitUsd, '7000');
    expectDecimal(result.commissionProfitUsd, '0');
  });

  it('calculates attendance bonus from attendance status only', () => {
    const results = calculate({
      employeeIds: ['SUB1', 'SUB2'],
      attendanceByEmployeeId: {
        SUB1: AttendanceStatus.full_attendance,
        SUB2: AttendanceStatus.sick_leave,
      },
      salaryManualItems: [
        {
          employeeId: 'SUB2',
          amountRmb: '0',
          status: CommonStatus.active,
          config: { itemType: SalaryItemType.deduction, code: 'leave_deduction' },
        },
      ],
    });

    expectDecimal(results.find((result) => result.employeeId === 'SUB1')!.attendanceBonusRmb, '500');
    expectDecimal(results.find((result) => result.employeeId === 'SUB2')!.attendanceBonusRmb, '0');
  });

  it('applies active and confirmed manual salary additions and deductions', () => {
    const [result] = calculate({
      employeeIds: ['SUB1'],
      salaryManualItems: [
        {
          employeeId: 'SUB1',
          amountRmb: '1000',
          status: CommonStatus.active,
          config: { itemType: SalaryItemType.addition, code: 'living_allowance' },
        },
        {
          employeeId: 'SUB1',
          amountRmb: '200',
          status: CommonStatus.confirmed,
          config: { itemType: SalaryItemType.deduction, code: 'leave_deduction' },
        },
        {
          employeeId: 'SUB1',
          amountRmb: '300',
          status: CommonStatus.confirmed,
          config: { itemType: SalaryItemType.deduction, code: 'profit_over_10000_to_advance' },
        },
      ],
    });

    expectDecimal(result.manualAdditionRmb, '1000');
    expectDecimal(result.manualDeductionRmb, '500');
    expectDecimal(result.finalSalaryRmb, '3500');
  });

  it('adds monthly provider fee to confirmed API card spend', () => {
    const [result] = calculate({
      employeeIds: ['SUB1'],
      apiCardSpendEvents: [
        {
          employeeId: 'SUB1',
          provider: Provider.airwallex,
          spendUsd: '10000',
          status: CommonStatus.confirmed,
        },
      ],
      cardProviderFeeRates: [{ provider: Provider.airwallex, feeRate: '0.03' }],
    });

    expectDecimal(result.apiCardSpendUsd, '10000');
    expectDecimal(result.apiCardFeeUsd, '300');
    expectDecimal(result.finalCardSpendUsd, '10300');
  });

  it('uses manual actual card spend directly in final card spend', () => {
    const [result] = calculate({
      employeeIds: ['SUB1'],
      manualCardSpendEntries: [
        {
          employeeId: 'SUB1',
          actualSpendUsd: '10500',
          status: SettlementStatus.confirmed,
        },
      ],
    });

    expectDecimal(result.manualCardSpendUsd, '10500');
    expectDecimal(result.finalCardSpendUsd, '10500');
  });

  it('rejects group allocation ratio sum that is not 1', () => {
    expect(() =>
      calculate({
        groupMembers: [
          { groupId: 'G1', employeeId: 'SUB1', allocationRatio: '0.5' },
          { groupId: 'G1', employeeId: 'SUB2', allocationRatio: '0.4' },
        ],
      }),
    ).toThrow(AppError);

    try {
      calculate({
        groupMembers: [
          { groupId: 'G1', employeeId: 'SUB1', allocationRatio: '0.5' },
          { groupId: 'G1', employeeId: 'SUB2', allocationRatio: '0.4' },
        ],
      });
    } catch (error) {
      expect((error as AppError).code).toBe(ERROR_CODES.SETTLEMENT_PRECHECK_FAILED);
    }
  });

  it('rejects confirmed API card spend when monthly provider fee is missing', () => {
    expect(() =>
      calculate({
        apiCardSpendEvents: [
          {
            employeeId: 'SUB1',
            provider: Provider.airwallex,
            spendUsd: '10000',
            status: CommonStatus.confirmed,
          },
        ],
      }),
    ).toThrow(AppError);

    try {
      calculate({
        apiCardSpendEvents: [
          {
            employeeId: 'SUB1',
            provider: Provider.airwallex,
            spendUsd: '10000',
            status: CommonStatus.confirmed,
          },
        ],
      });
    } catch (error) {
      expect((error as AppError).code).toBe(ERROR_CODES.SETTLEMENT_PRECHECK_FAILED);
    }
  });
});
