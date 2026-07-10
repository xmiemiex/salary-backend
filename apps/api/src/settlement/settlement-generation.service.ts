import { Injectable } from '@nestjs/common';
import {
  AttendanceStatus,
  CommonStatus,
  Prisma,
  SettlementStatus,
} from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { SettlementPreflightAuditSnapshot } from '../audit/audit.types';
import { AppError } from '../common/app-error';
import { LockActor } from '../month-lock/month-lock.types';
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  EmployeeSettlementCalculationResult,
  SettlementCalculationInput,
  SettlementCalculatorService,
} from './settlement-calculator.service';
import {
  SettlementPreflightResult,
  SettlementPreflightService,
} from './settlement-preflight.service';

const ACTIVE_RATE_STATUSES = [CommonStatus.active, CommonStatus.confirmed] as const;
const CARD_SPEND_SETTLEMENT_MONTH_RULE =
  'card_spend_events.settlement_month is based on transaction time in GMT+8, not settled_at';
const HISTORICAL_NEGATIVE_PROFIT_ROLL_FORWARD_RULE =
  'remainingNegativeProfitUsd is snapshotted here; creating next month historical_negative_profits is handled after confirmation/lock.';

export interface GenerateSettlementInput {
  settlementMonth: Date;
  actor: LockActor;
  attendanceByEmployeeId?: Record<string, AttendanceStatus>;
  acknowledgedWarningCodes?: unknown;
}

export interface SettlementGenerationResult {
  settlementId: string;
  settlementMonth: Date;
  detailCount: number;
}

type SettlementReadModel = {
  exchangeRate: { usdToRmbRate: Prisma.Decimal };
  incomeRecords: Array<{ employeeId: string | null; incomeUsd: Prisma.Decimal; status: CommonStatus }>;
  apiCardSpendEvents: Array<{
    employeeId: string | null;
    provider: string;
    spendUsd: Prisma.Decimal;
    status: CommonStatus;
  }>;
  manualCardSpendEntries: Array<{
    employeeId: string;
    actualSpendUsd: Prisma.Decimal;
    status: SettlementStatus;
  }>;
  cardProviderFeeRates: Array<{ provider: string; feeRate: Prisma.Decimal }>;
  groupMembers: Array<{ groupId: string; employeeId: string; allocationRatio: Prisma.Decimal }>;
  historicalNegativeProfits: Array<{ employeeId: string; amountUsd: Prisma.Decimal; status: CommonStatus }>;
  salaryManualItems: Array<{
    employeeId: string;
    amountRmb: Prisma.Decimal;
    status: CommonStatus;
    config: { itemType: string; code?: string; name?: string };
  }>;
};

@Injectable()
export class SettlementGenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
    private readonly calculator: SettlementCalculatorService,
    private readonly preflight: SettlementPreflightService,
  ) {}

  async generateSettlement(input: GenerateSettlementInput): Promise<SettlementGenerationResult> {
    const requestPayload = this.buildRequestPayload(input);

    try {
      this.assertSettlementMonthStart(input.settlementMonth);

      const preflightResult = await this.preflight.assertCanGenerate(
        input.settlementMonth,
        input.acknowledgedWarningCodes,
      );

      await this.monthLock.assertWritable(
        {
          settlementMonth: input.settlementMonth,
          action: 'settlement.generate',
          objectType: 'monthly_settlements',
          requestPayload,
        },
        input.actor,
      );

      const readModel = await this.readSettlementData(input.settlementMonth);
      this.precheckReadModel(readModel);

      const calculationInput = this.buildCalculationInput(input, readModel);
      const calculationResults = this.calculator.calculate(calculationInput);

      return await this.writeSettlement(input, calculationResults, requestPayload, preflightResult);
    } catch (error) {
      if (!this.isMonthLockedError(error)) {
        await this.writeFailureAudit(input, error, requestPayload);
      }
      throw error;
    }
  }

  private assertSettlementMonthStart(settlementMonth: Date): void {
    if (
      settlementMonth.getUTCDate() !== 1 ||
      settlementMonth.getUTCHours() !== 0 ||
      settlementMonth.getUTCMinutes() !== 0 ||
      settlementMonth.getUTCSeconds() !== 0 ||
      settlementMonth.getUTCMilliseconds() !== 0
    ) {
      throw new AppError(
        ERROR_CODES.SETTLEMENT_PRECHECK_FAILED,
        'settlementMonth must be the first day of the month at 00:00:00 UTC.',
        { settlementMonth: settlementMonth.toISOString() },
      );
    }
  }

  private async readSettlementData(settlementMonth: Date): Promise<SettlementReadModel> {
    const [
      exchangeRate,
      incomeRecords,
      apiCardSpendEvents,
      manualCardSpendEntries,
      cardProviderFeeRates,
      groupMembers,
      historicalNegativeProfits,
      salaryManualItems,
    ] = await Promise.all([
      this.prisma.monthlyExchangeRate.findFirst({
        where: { settlementMonth, status: { in: [...ACTIVE_RATE_STATUSES] } },
        select: { usdToRmbRate: true },
      }),
      this.prisma.incomeRecord.findMany({
        where: { settlementMonth, status: CommonStatus.confirmed },
        select: { employeeId: true, incomeUsd: true, status: true },
      }),
      this.prisma.cardSpendEvent.findMany({
        // card_spend_events.settlement_month must be derived from transaction time in GMT+8,
        // not from settled_at. API sync should update the same transaction by external_event_id
        // as pending becomes settled/cancelled; this generation service only consumes confirmed rows.
        where: { settlementMonth, status: CommonStatus.confirmed },
        select: { employeeId: true, provider: true, spendUsd: true, status: true },
      }),
      this.prisma.manualCardSpendEntry.findMany({
        where: { settlementMonth, status: SettlementStatus.confirmed },
        select: { employeeId: true, actualSpendUsd: true, status: true },
      }),
      this.prisma.monthlyCardProviderFeeRate.findMany({
        where: { settlementMonth, status: { in: [...ACTIVE_RATE_STATUSES] } },
        select: { provider: true, feeRate: true },
      }),
      this.prisma.monthlyPerformanceGroupMember.findMany({
        where: { settlementMonth },
        select: { groupId: true, employeeId: true, allocationRatio: true },
      }),
      this.prisma.historicalNegativeProfit.findMany({
        where: { settlementMonth, status: { in: [...ACTIVE_RATE_STATUSES] } },
        select: { employeeId: true, amountUsd: true, status: true },
      }),
      this.prisma.monthlySalaryManualItem.findMany({
        where: { settlementMonth, status: { in: [...ACTIVE_RATE_STATUSES] } },
        select: {
          employeeId: true,
          amountRmb: true,
          status: true,
          config: { select: { itemType: true, code: true, name: true } },
        },
      }),
    ]);

    if (!exchangeRate) {
      throw new AppError(ERROR_CODES.SETTLEMENT_PRECHECK_FAILED, 'Monthly exchange rate is required.', {
        settlementMonth: this.formatDate(settlementMonth),
      });
    }

    return {
      exchangeRate,
      incomeRecords,
      apiCardSpendEvents: apiCardSpendEvents as SettlementReadModel['apiCardSpendEvents'],
      manualCardSpendEntries,
      cardProviderFeeRates: cardProviderFeeRates as SettlementReadModel['cardProviderFeeRates'],
      groupMembers,
      historicalNegativeProfits,
      salaryManualItems: salaryManualItems as SettlementReadModel['salaryManualItems'],
    };
  }

  private precheckReadModel(readModel: SettlementReadModel): void {
    const unassignedIncomeCount = readModel.incomeRecords.filter((record) => !record.employeeId).length;
    if (unassignedIncomeCount > 0) {
      throw new AppError(ERROR_CODES.SETTLEMENT_PRECHECK_FAILED, 'Confirmed income records must belong to employees.', {
        unassignedIncomeCount,
      });
    }

    const unassignedApiSpendCount = readModel.apiCardSpendEvents.filter((event) => !event.employeeId).length;
    if (unassignedApiSpendCount > 0) {
      throw new AppError(
        ERROR_CODES.SETTLEMENT_PRECHECK_FAILED,
        'Confirmed API card spend events must belong to employees.',
        { unassignedApiSpendCount },
      );
    }

    const feeProviders = new Set(readModel.cardProviderFeeRates.map((rate) => rate.provider));
    const missingProviderFeeRates = [
      ...new Set(readModel.apiCardSpendEvents.map((event) => event.provider)),
    ].filter((provider) => !feeProviders.has(provider));
    if (missingProviderFeeRates.length > 0) {
      throw new AppError(
        ERROR_CODES.SETTLEMENT_PRECHECK_FAILED,
        'Monthly card provider fee rates are required for confirmed API card spend.',
        { missingProviderFeeRates },
      );
    }
  }

  private buildCalculationInput(
    input: GenerateSettlementInput,
    readModel: SettlementReadModel,
  ): SettlementCalculationInput {
    return {
      settlementMonth: input.settlementMonth,
      exchangeRate: readModel.exchangeRate.usdToRmbRate,
      employeeIds: this.collectEmployeeIds(readModel, input.attendanceByEmployeeId),
      incomeRecords: readModel.incomeRecords,
      apiCardSpendEvents: readModel.apiCardSpendEvents as SettlementCalculationInput['apiCardSpendEvents'],
      cardProviderFeeRates: readModel.cardProviderFeeRates as SettlementCalculationInput['cardProviderFeeRates'],
      manualCardSpendEntries: readModel.manualCardSpendEntries,
      groupMembers: readModel.groupMembers,
      historicalNegativeProfits: readModel.historicalNegativeProfits,
      salaryManualItems: readModel.salaryManualItems as SettlementCalculationInput['salaryManualItems'],
      attendanceByEmployeeId: input.attendanceByEmployeeId,
    };
  }

  private collectEmployeeIds(
    readModel: SettlementReadModel,
    attendanceByEmployeeId?: Record<string, AttendanceStatus>,
  ): string[] {
    const employeeIds = new Set<string>(Object.keys(attendanceByEmployeeId ?? {}));

    for (const record of readModel.incomeRecords) {
      if (record.employeeId) employeeIds.add(record.employeeId);
    }
    for (const event of readModel.apiCardSpendEvents) {
      if (event.employeeId) employeeIds.add(event.employeeId);
    }
    for (const entry of readModel.manualCardSpendEntries) {
      employeeIds.add(entry.employeeId);
    }
    for (const profit of readModel.historicalNegativeProfits) {
      employeeIds.add(profit.employeeId);
    }
    for (const item of readModel.salaryManualItems) {
      employeeIds.add(item.employeeId);
    }
    for (const member of readModel.groupMembers) {
      employeeIds.add(member.employeeId);
    }

    return [...employeeIds];
  }

  private async writeSettlement(
    input: GenerateSettlementInput,
    calculationResults: EmployeeSettlementCalculationResult[],
    requestPayload: unknown,
    preflightResult: SettlementPreflightResult,
  ): Promise<SettlementGenerationResult> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.monthlySettlement.findUnique({
        where: { settlementMonth: input.settlementMonth },
      });

      if (existing?.status === SettlementStatus.locked) {
        throw new AppError(ERROR_CODES.MONTH_LOCKED, 'Settlement month is locked and cannot be regenerated.');
      }

      const settlement = await tx.monthlySettlement.upsert({
        where: { settlementMonth: input.settlementMonth },
        update: {
          generatedAt: new Date(),
          generatedBy: input.actor.userId,
        },
        create: {
          settlementMonth: input.settlementMonth,
          status: SettlementStatus.draft,
          generatedAt: new Date(),
          generatedBy: input.actor.userId,
        },
      });

      await tx.monthlySettlementDetail.deleteMany({
        where: { settlementId: settlement.id },
      });

      if (calculationResults.length > 0) {
        await tx.monthlySettlementDetail.createMany({
          data: calculationResults.map((result) => this.toSettlementDetailCreateInput(settlement.id, result)),
        });
      }

      await this.audit.success(
        {
          actorUserId: input.actor.userId,
          actorRole: input.actor.roleCode,
          action: 'settlement.generate',
          objectType: 'monthly_settlement',
          objectId: settlement.id,
          settlementMonth: input.settlementMonth,
          afterData: {
            settlementId: settlement.id,
            settlementMonth: this.formatDate(input.settlementMonth),
            detailCount: calculationResults.length,
            preflight: this.buildPreflightAuditSnapshot(preflightResult),
          },
          changedFields: ['generatedAt', 'generatedBy', 'details'],
          requestPayload,
          ipAddress: input.actor.ipAddress,
          userAgent: input.actor.userAgent,
        },
        tx,
      );

      return {
        settlementId: settlement.id,
        settlementMonth: settlement.settlementMonth,
        detailCount: calculationResults.length,
      };
    });
  }

  private toSettlementDetailCreateInput(
    settlementId: string,
    result: EmployeeSettlementCalculationResult,
  ): Prisma.MonthlySettlementDetailCreateManyInput {
    return {
      settlementId,
      employeeId: result.employeeId,
      settlementMonth: result.settlementMonth,
      attendanceStatus: result.attendanceStatus,
      incomeUsd: result.totalRevenueUsd,
      cardSpendUsd: result.finalCardSpendUsd,
      grossProfitUsd: result.originalProfitUsd,
      grossProfitRmb: result.originalProfitUsd.times(result.exchangeRate),
      commissionRmb: result.commissionRmb,
      manualAdditionRmb: result.manualAdditionRmb,
      manualDeductionRmb: result.manualDeductionRmb,
      finalSalaryRmb: result.finalSalaryRmb,
      snapshot: this.buildDetailSnapshot(result),
    };
  }

  private buildDetailSnapshot(result: EmployeeSettlementCalculationResult): Prisma.InputJsonObject {
    return {
      ...this.jsonSafe(result.snapshot),
      salaryMode: result.salaryMode,
      groupId: result.groupId,
      allocationRatio: this.decimalToString(result.allocationRatio),
      allocatedProfitUsd: this.decimalToString(result.allocatedProfitUsd),
      historicalNegativeProfitUsd: this.decimalToString(result.historicalNegativeProfitUsd),
      commissionProfitUsd: this.decimalToString(result.commissionProfitUsd),
      remainingNegativeProfitUsd: this.decimalToString(result.remainingNegativeProfitUsd),
      baseSalaryRmb: this.decimalToString(result.baseSalaryRmb),
      starAllowanceRmb: this.decimalToString(result.starAllowanceRmb),
      commissionRate: this.decimalToString(result.commissionRate),
      commissionUsd: this.decimalToString(result.commissionUsd),
      exchangeRate: this.decimalToString(result.exchangeRate),
      attendanceBonusRmb: this.decimalToString(result.attendanceBonusRmb),
      apiCardSpendUsd: this.decimalToString(result.apiCardSpendUsd),
      apiCardFeeUsd: this.decimalToString(result.apiCardFeeUsd),
      manualCardSpendUsd: this.decimalToString(result.manualCardSpendUsd),
      cardSpendSettlementMonthRule: CARD_SPEND_SETTLEMENT_MONTH_RULE,
      // Do not write next month historical_negative_profits here; confirmation/lock owns that roll-forward.
      historicalNegativeProfitRollForwardRule: HISTORICAL_NEGATIVE_PROFIT_ROLL_FORWARD_RULE,
    };
  }

  private async writeFailureAudit(
    input: GenerateSettlementInput,
    error: unknown,
    requestPayload: unknown,
  ): Promise<void> {
    await this.audit.failure({
      actorUserId: input.actor.userId,
      actorRole: input.actor.roleCode,
      action: 'settlement.generate',
      objectType: 'monthly_settlement',
      settlementMonth: input.settlementMonth,
      requestPayload,
      failureReason: this.failureReason(error),
      errorMessage: error instanceof Error ? error.message : String(error),
      ipAddress: input.actor.ipAddress,
      userAgent: input.actor.userAgent,
    });
  }

  private buildRequestPayload(input: GenerateSettlementInput): Record<string, unknown> {
    const acknowledgedWarningCodeCount = Array.isArray(input.acknowledgedWarningCodes)
      ? input.acknowledgedWarningCodes.length
      : 0;

    return {
      settlementMonth: this.formatDate(input.settlementMonth),
      actorUserId: input.actor.userId,
      attendanceEmployeeCount: Object.keys(input.attendanceByEmployeeId ?? {}).length,
      hasAttendanceByEmployeeId: !!input.attendanceByEmployeeId,
      acknowledgedWarningCodeCount,
      hasWarningAcknowledgement: input.acknowledgedWarningCodes !== undefined,
    };
  }

  private buildPreflightAuditSnapshot(
    result: SettlementPreflightResult,
  ): SettlementPreflightAuditSnapshot {
    if (result.severity === 'blocking' || !result.canGenerate) {
      throw new AppError(
        ERROR_CODES.SETTLEMENT_PRECHECK_FAILED,
        'Blocking preflight results cannot be written to a successful generation audit.',
      );
    }

    return {
      settlementMonth: result.settlementMonth,
      severity: result.severity,
      canGenerate: result.canGenerate,
      checks: result.checks.map((check) => ({
        code: check.code,
        severity: check.severity,
        message: check.message,
        ...(check.count === undefined ? {} : { count: check.count }),
        ...(check.amountUsd === undefined ? {} : { amountUsd: check.amountUsd }),
      })),
      summary: {
        openUnmatchedEventCount: result.summary.openUnmatchedEventCount,
        missingProviderFeeRateCount: result.summary.missingProviderFeeRateCount,
        missingExchangeRate: result.summary.missingExchangeRate,
        draftManualRecordCount: result.summary.draftManualRecordCount,
        runningOrPendingSyncTaskCount: result.summary.runningOrPendingSyncTaskCount,
        isLocked: result.summary.isLocked,
      },
      acknowledgedWarningCodes: result.severity === 'warning'
        ? result.checks.filter((check) => check.severity === 'warning').map((check) => check.code)
        : [],
    };
  }

  private failureReason(error: unknown): string {
    return error instanceof AppError ? error.code : ERROR_CODES.SETTLEMENT_PRECHECK_FAILED;
  }

  private isMonthLockedError(error: unknown): boolean {
    return error instanceof AppError && error.code === ERROR_CODES.MONTH_LOCKED;
  }

  private decimalToString(value: Prisma.Decimal | null): string | null {
    return value?.toString() ?? null;
  }

  private jsonSafe(value: Record<string, unknown>): Prisma.InputJsonObject {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
  }

  private formatDate(value: Date): string {
    return value.toISOString().slice(0, 10);
  }
}
