import { Injectable } from '@nestjs/common';
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
import { AppError } from '../common/app-error';

type DecimalInput = Prisma.Decimal | string;

export interface SettlementIncomeRecordInput {
  employeeId: string | null;
  incomeUsd: DecimalInput;
  status: CommonStatus;
}

export interface SettlementApiCardSpendInput {
  employeeId: string | null;
  provider: Provider;
  spendUsd: DecimalInput;
  status: CommonStatus;
}

export interface SettlementManualCardSpendInput {
  employeeId: string;
  actualSpendUsd: DecimalInput;
  status: SettlementStatus;
}

export interface SettlementCardProviderFeeRateInput {
  provider: Provider;
  feeRate: DecimalInput;
}

export interface SettlementPerformanceGroupMemberInput {
  groupId: string;
  employeeId: string;
  allocationRatio: DecimalInput;
}

export interface SettlementHistoricalNegativeProfitInput {
  employeeId: string;
  amountUsd: DecimalInput;
  status: CommonStatus;
}

export interface SettlementSalaryManualItemInput {
  employeeId: string;
  amountRmb: DecimalInput;
  status: CommonStatus;
  config: {
    itemType: SalaryItemType;
    code?: string;
    name?: string;
  };
}

export interface SettlementCalculationInput {
  settlementMonth: Date;
  exchangeRate: DecimalInput;
  employeeIds?: string[];
  incomeRecords?: SettlementIncomeRecordInput[];
  apiCardSpendEvents?: SettlementApiCardSpendInput[];
  cardProviderFeeRates?: SettlementCardProviderFeeRateInput[];
  manualCardSpendEntries?: SettlementManualCardSpendInput[];
  groupMembers?: SettlementPerformanceGroupMemberInput[];
  historicalNegativeProfits?: SettlementHistoricalNegativeProfitInput[];
  salaryManualItems?: SettlementSalaryManualItemInput[];
  attendanceByEmployeeId?: Record<string, AttendanceStatus>;
}

export interface SalaryTierResult {
  baseSalaryRmb: Prisma.Decimal;
  starAllowanceRmb: Prisma.Decimal;
  commissionRate: Prisma.Decimal;
}

export interface NegativeCarryoverResult {
  commissionProfitUsd: Prisma.Decimal;
  remainingNegativeProfitUsd: Prisma.Decimal;
}

export interface EmployeeSettlementCalculationResult {
  employeeId: string;
  settlementMonth: Date;
  salaryMode: SalaryMode;
  totalRevenueUsd: Prisma.Decimal;
  apiCardSpendUsd: Prisma.Decimal;
  apiCardFeeUsd: Prisma.Decimal;
  manualCardSpendUsd: Prisma.Decimal;
  finalCardSpendUsd: Prisma.Decimal;
  originalProfitUsd: Prisma.Decimal;
  groupId: string | null;
  allocationRatio: Prisma.Decimal | null;
  allocatedProfitUsd: Prisma.Decimal;
  historicalNegativeProfitUsd: Prisma.Decimal;
  commissionProfitUsd: Prisma.Decimal;
  remainingNegativeProfitUsd: Prisma.Decimal;
  baseSalaryRmb: Prisma.Decimal;
  starAllowanceRmb: Prisma.Decimal;
  commissionRate: Prisma.Decimal;
  commissionUsd: Prisma.Decimal;
  exchangeRate: Prisma.Decimal;
  commissionRmb: Prisma.Decimal;
  attendanceStatus: AttendanceStatus;
  attendanceBonusRmb: Prisma.Decimal;
  manualAdditionRmb: Prisma.Decimal;
  manualDeductionRmb: Prisma.Decimal;
  finalSalaryRmb: Prisma.Decimal;
  snapshot: Record<string, unknown>;
}

interface EmployeeProfit {
  totalRevenueUsd: Prisma.Decimal;
  apiCardSpendUsd: Prisma.Decimal;
  apiCardFeeUsd: Prisma.Decimal;
  manualCardSpendUsd: Prisma.Decimal;
  finalCardSpendUsd: Prisma.Decimal;
  originalProfitUsd: Prisma.Decimal;
}

const ZERO = new Prisma.Decimal('0');
const ONE = new Prisma.Decimal('1');
const FULL_ATTENDANCE_BONUS_RMB = new Prisma.Decimal('500');

function decimal(value: DecimalInput): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function addToMap(map: Map<string, Prisma.Decimal>, key: string, value: DecimalInput): void {
  map.set(key, (map.get(key) ?? ZERO).plus(decimal(value)));
}

function assertPrecheck(condition: boolean, message: string, details?: unknown): void {
  if (!condition) {
    throw new AppError(ERROR_CODES.SETTLEMENT_PRECHECK_FAILED, message, details);
  }
}

function decimalToString(value: Prisma.Decimal | null): string | null {
  return value?.toString() ?? null;
}

export function calculateSalaryTier(
  commissionProfitUsd: DecimalInput,
  salaryMode: SalaryMode,
): SalaryTierResult {
  const profit = decimal(commissionProfitUsd);

  if (profit.lt(3000)) {
    return {
      baseSalaryRmb: new Prisma.Decimal('2500'),
      starAllowanceRmb: ZERO,
      commissionRate: ZERO,
    };
  }

  if (profit.lt(5000)) {
    return {
      baseSalaryRmb: new Prisma.Decimal('3000'),
      starAllowanceRmb: salaryMode === SalaryMode.single ? new Prisma.Decimal('300') : ZERO,
      commissionRate: salaryMode === SalaryMode.single ? new Prisma.Decimal('0.04') : ZERO,
    };
  }

  if (profit.lt(15000)) {
    return {
      baseSalaryRmb: new Prisma.Decimal('3000'),
      starAllowanceRmb: new Prisma.Decimal('500'),
      commissionRate: new Prisma.Decimal('0.06'),
    };
  }

  if (profit.lt(30000)) {
    return {
      baseSalaryRmb: new Prisma.Decimal('3000'),
      starAllowanceRmb: new Prisma.Decimal('1000'),
      commissionRate: new Prisma.Decimal('0.08'),
    };
  }

  if (profit.lt(50000)) {
    return {
      baseSalaryRmb: new Prisma.Decimal('3000'),
      starAllowanceRmb: new Prisma.Decimal('2000'),
      commissionRate: new Prisma.Decimal('0.10'),
    };
  }

  if (profit.lt(100000)) {
    return {
      baseSalaryRmb: new Prisma.Decimal('3000'),
      starAllowanceRmb: new Prisma.Decimal('3000'),
      commissionRate: new Prisma.Decimal('0.14'),
    };
  }

  return {
    baseSalaryRmb: new Prisma.Decimal('3000'),
    starAllowanceRmb: new Prisma.Decimal('4000'),
    commissionRate: new Prisma.Decimal('0.18'),
  };
}

export function applyNegativeCarryover(
  allocatedProfitUsd: DecimalInput,
  historicalNegativeProfitUsd: DecimalInput,
): NegativeCarryoverResult {
  const profitAfterCarryover = decimal(allocatedProfitUsd).minus(decimal(historicalNegativeProfitUsd));

  if (profitAfterCarryover.gte(0)) {
    return {
      commissionProfitUsd: profitAfterCarryover,
      remainingNegativeProfitUsd: ZERO,
    };
  }

  return {
    commissionProfitUsd: ZERO,
    remainingNegativeProfitUsd: profitAfterCarryover.abs(),
  };
}

export function calculateAttendanceBonus(attendanceStatus: AttendanceStatus): Prisma.Decimal {
  return attendanceStatus === AttendanceStatus.full_attendance ? FULL_ATTENDANCE_BONUS_RMB : ZERO;
}

export function calculateFinalSalary(input: {
  baseSalaryRmb: DecimalInput;
  starAllowanceRmb: DecimalInput;
  attendanceBonusRmb: DecimalInput;
  commissionRmb: DecimalInput;
  manualAdditionRmb: DecimalInput;
  manualDeductionRmb: DecimalInput;
}): Prisma.Decimal {
  return decimal(input.baseSalaryRmb)
    .plus(input.starAllowanceRmb)
    .plus(input.attendanceBonusRmb)
    .plus(input.commissionRmb)
    .plus(input.manualAdditionRmb)
    .minus(input.manualDeductionRmb);
}

@Injectable()
export class SettlementCalculatorService {
  calculate(input: SettlementCalculationInput): EmployeeSettlementCalculationResult[] {
    this.precheck(input);

    const settlementMonth = input.settlementMonth;
    const exchangeRate = decimal(input.exchangeRate);
    const employeeIds = this.collectEmployeeIds(input);
    const profits = this.calculateEmployeeProfits(input, employeeIds);
    const groupsByEmployee = this.buildGroupsByEmployee(input.groupMembers ?? []);
    const groupTotals = this.calculateGroupTotals(input.groupMembers ?? [], profits);
    const historicalNegativeProfits = this.sumHistoricalNegativeProfits(input.historicalNegativeProfits ?? []);
    const manualItems = this.sumManualSalaryItems(input.salaryManualItems ?? []);

    return employeeIds
      .sort()
      .map((employeeId) => {
        const profit = profits.get(employeeId) ?? this.emptyEmployeeProfit();
        const groupMember = groupsByEmployee.get(employeeId);
        const salaryMode = groupMember ? SalaryMode.group : SalaryMode.single;
        const allocationRatio = groupMember ? decimal(groupMember.allocationRatio) : null;
        const allocatedProfitUsd = groupMember
          ? (groupTotals.get(groupMember.groupId) ?? ZERO).times(allocationRatio ?? ZERO)
          : profit.originalProfitUsd;
        const historicalNegativeProfitUsd = historicalNegativeProfits.get(employeeId) ?? ZERO;
        const carryover = applyNegativeCarryover(allocatedProfitUsd, historicalNegativeProfitUsd);
        const tier = calculateSalaryTier(carryover.commissionProfitUsd, salaryMode);
        const commissionUsd = carryover.commissionProfitUsd.times(tier.commissionRate);
        const commissionRmb = commissionUsd.times(exchangeRate);
        const attendanceStatus =
          input.attendanceByEmployeeId?.[employeeId] ?? AttendanceStatus.full_attendance;
        const attendanceBonusRmb = calculateAttendanceBonus(attendanceStatus);
        const manualSalaryItem = manualItems.get(employeeId) ?? {
          additionRmb: ZERO,
          deductionRmb: ZERO,
        };
        const finalSalaryRmb = calculateFinalSalary({
          ...tier,
          attendanceBonusRmb,
          commissionRmb,
          manualAdditionRmb: manualSalaryItem.additionRmb,
          manualDeductionRmb: manualSalaryItem.deductionRmb,
        });

        const result: EmployeeSettlementCalculationResult = {
          employeeId,
          settlementMonth,
          salaryMode,
          totalRevenueUsd: profit.totalRevenueUsd,
          apiCardSpendUsd: profit.apiCardSpendUsd,
          apiCardFeeUsd: profit.apiCardFeeUsd,
          manualCardSpendUsd: profit.manualCardSpendUsd,
          finalCardSpendUsd: profit.finalCardSpendUsd,
          originalProfitUsd: profit.originalProfitUsd,
          groupId: groupMember?.groupId ?? null,
          allocationRatio,
          allocatedProfitUsd,
          historicalNegativeProfitUsd,
          commissionProfitUsd: carryover.commissionProfitUsd,
          remainingNegativeProfitUsd: carryover.remainingNegativeProfitUsd,
          baseSalaryRmb: tier.baseSalaryRmb,
          starAllowanceRmb: tier.starAllowanceRmb,
          commissionRate: tier.commissionRate,
          commissionUsd,
          exchangeRate,
          commissionRmb,
          attendanceStatus,
          attendanceBonusRmb,
          manualAdditionRmb: manualSalaryItem.additionRmb,
          manualDeductionRmb: manualSalaryItem.deductionRmb,
          finalSalaryRmb,
          snapshot: {},
        };

        result.snapshot = this.buildSnapshot(result);
        return result;
      });
  }

  private precheck(input: SettlementCalculationInput): void {
    const unassignedIncomeCount = (input.incomeRecords ?? []).filter(
      (record) => record.status === CommonStatus.confirmed && !record.employeeId,
    ).length;
    assertPrecheck(unassignedIncomeCount === 0, 'Confirmed income records must belong to employees.', {
      unassignedIncomeCount,
    });

    const unassignedApiSpendCount = (input.apiCardSpendEvents ?? []).filter(
      (event) => event.status === CommonStatus.confirmed && !event.employeeId,
    ).length;
    assertPrecheck(unassignedApiSpendCount === 0, 'Confirmed API card spend events must belong to employees.', {
      unassignedApiSpendCount,
    });

    const configuredProviders = new Set((input.cardProviderFeeRates ?? []).map((rate) => rate.provider));
    const providersWithConfirmedSpend = new Set(
      (input.apiCardSpendEvents ?? [])
        .filter((event) => event.status === CommonStatus.confirmed)
        .map((event) => event.provider),
    );
    const missingProviderFeeRates = [...providersWithConfirmedSpend].filter(
      (provider) => !configuredProviders.has(provider),
    );
    assertPrecheck(
      missingProviderFeeRates.length === 0,
      'Monthly card provider fee rates are required for confirmed API card spend.',
      { missingProviderFeeRates },
    );

    const membersByEmployee = new Set<string>();
    for (const member of input.groupMembers ?? []) {
      assertPrecheck(!membersByEmployee.has(member.employeeId), 'Employee can only belong to one group per month.', {
        employeeId: member.employeeId,
      });
      membersByEmployee.add(member.employeeId);
    }

    const ratiosByGroup = new Map<string, Prisma.Decimal>();
    for (const member of input.groupMembers ?? []) {
      addToMap(ratiosByGroup, member.groupId, member.allocationRatio);
    }
    for (const [groupId, ratioSum] of ratiosByGroup.entries()) {
      assertPrecheck(ratioSum.equals(ONE), 'Performance group allocation ratio sum must equal 1.', {
        groupId,
        ratioSum: ratioSum.toString(),
      });
    }
  }

  private collectEmployeeIds(input: SettlementCalculationInput): string[] {
    const employeeIds = new Set(input.employeeIds ?? []);

    for (const record of input.incomeRecords ?? []) {
      if (record.status === CommonStatus.confirmed && record.employeeId) {
        employeeIds.add(record.employeeId);
      }
    }
    for (const event of input.apiCardSpendEvents ?? []) {
      if (event.status === CommonStatus.confirmed && event.employeeId) {
        employeeIds.add(event.employeeId);
      }
    }
    for (const entry of input.manualCardSpendEntries ?? []) {
      if (entry.status === SettlementStatus.confirmed) {
        employeeIds.add(entry.employeeId);
      }
    }
    for (const member of input.groupMembers ?? []) {
      employeeIds.add(member.employeeId);
    }
    for (const profit of input.historicalNegativeProfits ?? []) {
      if (profit.status === CommonStatus.active || profit.status === CommonStatus.confirmed) {
        employeeIds.add(profit.employeeId);
      }
    }
    for (const item of input.salaryManualItems ?? []) {
      if (item.status === CommonStatus.active || item.status === CommonStatus.confirmed) {
        employeeIds.add(item.employeeId);
      }
    }

    return [...employeeIds];
  }

  private calculateEmployeeProfits(
    input: SettlementCalculationInput,
    employeeIds: string[],
  ): Map<string, EmployeeProfit> {
    const revenueByEmployee = new Map<string, Prisma.Decimal>();
    const apiSpendByEmployee = new Map<string, Prisma.Decimal>();
    const apiFeeByEmployee = new Map<string, Prisma.Decimal>();
    const manualSpendByEmployee = new Map<string, Prisma.Decimal>();
    const feeRatesByProvider = new Map(
      (input.cardProviderFeeRates ?? []).map((rate) => [rate.provider, decimal(rate.feeRate)]),
    );

    for (const record of input.incomeRecords ?? []) {
      if (record.status === CommonStatus.confirmed && record.employeeId) {
        addToMap(revenueByEmployee, record.employeeId, record.incomeUsd);
      }
    }

    for (const event of input.apiCardSpendEvents ?? []) {
      if (event.status !== CommonStatus.confirmed || !event.employeeId) {
        continue;
      }

      const spendUsd = decimal(event.spendUsd);
      const feeUsd = spendUsd.times(feeRatesByProvider.get(event.provider) ?? ZERO);
      addToMap(apiSpendByEmployee, event.employeeId, spendUsd);
      addToMap(apiFeeByEmployee, event.employeeId, feeUsd);
    }

    for (const entry of input.manualCardSpendEntries ?? []) {
      if (entry.status === SettlementStatus.confirmed) {
        addToMap(manualSpendByEmployee, entry.employeeId, entry.actualSpendUsd);
      }
    }

    return new Map(
      employeeIds.map((employeeId) => {
        const totalRevenueUsd = revenueByEmployee.get(employeeId) ?? ZERO;
        const apiCardSpendUsd = apiSpendByEmployee.get(employeeId) ?? ZERO;
        const apiCardFeeUsd = apiFeeByEmployee.get(employeeId) ?? ZERO;
        const manualCardSpendUsd = manualSpendByEmployee.get(employeeId) ?? ZERO;
        const finalCardSpendUsd = apiCardSpendUsd.plus(apiCardFeeUsd).plus(manualCardSpendUsd);
        const originalProfitUsd = totalRevenueUsd.minus(finalCardSpendUsd);

        return [
          employeeId,
          {
            totalRevenueUsd,
            apiCardSpendUsd,
            apiCardFeeUsd,
            manualCardSpendUsd,
            finalCardSpendUsd,
            originalProfitUsd,
          },
        ];
      }),
    );
  }

  private buildGroupsByEmployee(
    groupMembers: SettlementPerformanceGroupMemberInput[],
  ): Map<string, SettlementPerformanceGroupMemberInput> {
    return new Map(groupMembers.map((member) => [member.employeeId, member]));
  }

  private calculateGroupTotals(
    groupMembers: SettlementPerformanceGroupMemberInput[],
    profits: Map<string, EmployeeProfit>,
  ): Map<string, Prisma.Decimal> {
    const groupTotals = new Map<string, Prisma.Decimal>();

    for (const member of groupMembers) {
      addToMap(groupTotals, member.groupId, profits.get(member.employeeId)?.originalProfitUsd ?? ZERO);
    }

    return groupTotals;
  }

  private sumHistoricalNegativeProfits(
    historicalNegativeProfits: SettlementHistoricalNegativeProfitInput[],
  ): Map<string, Prisma.Decimal> {
    const result = new Map<string, Prisma.Decimal>();

    for (const profit of historicalNegativeProfits) {
      if (profit.status === CommonStatus.active || profit.status === CommonStatus.confirmed) {
        addToMap(result, profit.employeeId, profit.amountUsd);
      }
    }

    return result;
  }

  private sumManualSalaryItems(
    salaryManualItems: SettlementSalaryManualItemInput[],
  ): Map<string, { additionRmb: Prisma.Decimal; deductionRmb: Prisma.Decimal }> {
    const result = new Map<string, { additionRmb: Prisma.Decimal; deductionRmb: Prisma.Decimal }>();

    for (const item of salaryManualItems) {
      if (item.status !== CommonStatus.active && item.status !== CommonStatus.confirmed) {
        continue;
      }

      const current = result.get(item.employeeId) ?? {
        additionRmb: ZERO,
        deductionRmb: ZERO,
      };
      const amount = decimal(item.amountRmb);
      if (item.config.itemType === SalaryItemType.addition) {
        current.additionRmb = current.additionRmb.plus(amount);
      } else {
        current.deductionRmb = current.deductionRmb.plus(amount);
      }
      result.set(item.employeeId, current);
    }

    return result;
  }

  private emptyEmployeeProfit(): EmployeeProfit {
    return {
      totalRevenueUsd: ZERO,
      apiCardSpendUsd: ZERO,
      apiCardFeeUsd: ZERO,
      manualCardSpendUsd: ZERO,
      finalCardSpendUsd: ZERO,
      originalProfitUsd: ZERO,
    };
  }

  private buildSnapshot(result: EmployeeSettlementCalculationResult): Record<string, unknown> {
    return {
      employeeId: result.employeeId,
      settlementMonth: result.settlementMonth.toISOString().slice(0, 10),
      salaryMode: result.salaryMode,
      revenue: {
        totalRevenueUsd: decimalToString(result.totalRevenueUsd),
      },
      cardSpend: {
        apiCardSpendUsd: decimalToString(result.apiCardSpendUsd),
        apiCardFeeUsd: decimalToString(result.apiCardFeeUsd),
        manualCardSpendUsd: decimalToString(result.manualCardSpendUsd),
        finalCardSpendUsd: decimalToString(result.finalCardSpendUsd),
      },
      profit: {
        originalProfitUsd: decimalToString(result.originalProfitUsd),
        groupId: result.groupId,
        allocationRatio: decimalToString(result.allocationRatio),
        allocatedProfitUsd: decimalToString(result.allocatedProfitUsd),
        historicalNegativeProfitUsd: decimalToString(result.historicalNegativeProfitUsd),
        commissionProfitUsd: decimalToString(result.commissionProfitUsd),
        remainingNegativeProfitUsd: decimalToString(result.remainingNegativeProfitUsd),
      },
      salary: {
        baseSalaryRmb: decimalToString(result.baseSalaryRmb),
        starAllowanceRmb: decimalToString(result.starAllowanceRmb),
        commissionRate: decimalToString(result.commissionRate),
        commissionUsd: decimalToString(result.commissionUsd),
        exchangeRate: decimalToString(result.exchangeRate),
        commissionRmb: decimalToString(result.commissionRmb),
        attendanceStatus: result.attendanceStatus,
        attendanceBonusRmb: decimalToString(result.attendanceBonusRmb),
        manualAdditionRmb: decimalToString(result.manualAdditionRmb),
        manualDeductionRmb: decimalToString(result.manualDeductionRmb),
        finalSalaryRmb: decimalToString(result.finalSalaryRmb),
      },
    };
  }
}
