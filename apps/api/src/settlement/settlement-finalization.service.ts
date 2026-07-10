import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma, SettlementStatus } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../base-data/base-data.types';
import { AppError } from '../common/app-error';
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';
import { formatSettlementMonth, nextSettlementMonth } from './settlement-month.util';

const ZERO = new Prisma.Decimal('0');
const ROLL_FORWARD_ACTION = 'historical_negative_profit.roll_forward';

type SettlementWithDetails = Prisma.MonthlySettlementGetPayload<{
  include: { details: true };
}>;

type SettlementDetail = SettlementWithDetails['details'][number];

export interface LockSettlementInput {
  lockReason: string;
}

export interface SettlementDetailsQuery {
  employeeId?: string;
  page?: string | number;
  pageSize?: string | number;
}

@Injectable()
export class SettlementFinalizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
  ) {}

  async confirmSettlement(settlementMonth: Date, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const settlement = await tx.monthlySettlement.findUnique({
        where: { settlementMonth },
        include: { details: true },
      });

      this.assertConfirmable(settlement);

      const after = await tx.monthlySettlement.update({
        where: { id: settlement.id },
        data: {
          status: SettlementStatus.confirmed,
          confirmedAt: new Date(),
          confirmedBy: actor.userId,
        },
      });

      await this.audit.success(
        {
          actorUserId: actor.userId,
          actorRole: actor.roleCode,
          action: 'settlement.confirm',
          objectType: 'monthly_settlement',
          objectId: settlement.id,
          settlementMonth,
          beforeData: settlement,
          afterData: after,
          changedFields: ['status', 'confirmedAt', 'confirmedBy'],
          requestPayload: { settlementMonth: formatSettlementMonth(settlementMonth) },
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        },
        tx,
      );

      return after;
    });
  }

  async lockSettlement(settlementMonth: Date, actor: Actor, input: Partial<LockSettlementInput> = {}) {
    const settlement = await this.prisma.monthlySettlement.findUnique({
      where: { settlementMonth },
      include: { details: true },
    });

    this.assertLockable(settlement);

    const locked = await this.monthLock.lockMonth(settlementMonth, actor, input.lockReason ?? '');

    // MonthLockService currently owns its own DB write and success audit and does not expose
    // a transaction hook. Roll-forward is therefore executed after a successful lock and kept
    // idempotent by employeeId + nextMonth + fixed reason.
    const rollForward = await this.rollForwardNegativeProfits(settlement, actor);

    return {
      ...locked,
      negativeProfitRollForward: rollForward,
    };
  }

  async getSettlementSummary(settlementMonth: Date) {
    const settlement = await this.prisma.monthlySettlement.findUnique({
      where: { settlementMonth },
      include: { details: true },
    });
    if (!settlement) {
      throw new AppError(ERROR_CODES.SETTLEMENT_NOT_FOUND, 'Settlement not found.');
    }

    return {
      settlement: this.serializeSettlement(settlement),
      detailCount: settlement.details.length,
      totalFinalSalaryRmb: this.sum(settlement.details.map((detail) => detail.finalSalaryRmb)).toString(),
      totalCommissionRmb: this.sum(settlement.details.map((detail) => detail.commissionRmb)).toString(),
      totalGrossProfitUsd: this.sum(settlement.details.map((detail) => detail.grossProfitUsd)).toString(),
      status: settlement.status,
    };
  }

  async getSettlementDetails(settlementMonth: Date, query: SettlementDetailsQuery = {}) {
    const settlement = await this.prisma.monthlySettlement.findUnique({
      where: { settlementMonth },
      select: { id: true },
    });
    if (!settlement) {
      throw new AppError(ERROR_CODES.SETTLEMENT_NOT_FOUND, 'Settlement not found.');
    }

    const page = this.parsePositiveInt(query.page, 1, 'page');
    const pageSize = this.parsePositiveInt(query.pageSize, 50, 'pageSize');
    const where: Prisma.MonthlySettlementDetailWhereInput = {
      settlementId: settlement.id,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    };

    const [total, details] = await Promise.all([
      this.prisma.monthlySettlementDetail.count({ where }),
      this.prisma.monthlySettlementDetail.findMany({
        where,
        orderBy: { employeeId: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      page,
      pageSize,
      total,
      items: details.map((detail) => this.serializeDetail(detail)),
    };
  }

  async exportSettlementCsv(settlementMonth: Date, actor: Actor): Promise<string> {
    const settlement = await this.prisma.monthlySettlement.findUnique({
      where: { settlementMonth },
      include: { details: { orderBy: { employeeId: 'asc' } } },
    });
    if (!settlement) {
      throw new AppError(ERROR_CODES.SETTLEMENT_NOT_FOUND, 'Settlement not found.');
    }

    const header = [
      'settlement_month',
      'employee_id',
      'income_usd',
      'card_spend_usd',
      'gross_profit_usd',
      'commission_profit_usd',
      'remaining_negative_profit_usd',
      'base_salary_rmb',
      'star_allowance_rmb',
      'commission_rate',
      'commission_usd',
      'commission_rmb',
      'attendance_bonus_rmb',
      'manual_addition_rmb',
      'manual_deduction_rmb',
      'final_salary_rmb',
      'salary_mode',
      'group_id',
    ];
    const rows = settlement.details.map((detail) => {
      const snapshot = this.snapshot(detail);
      return [
        formatSettlementMonth(settlementMonth),
        detail.employeeId,
        detail.incomeUsd.toString(),
        detail.cardSpendUsd.toString(),
        detail.grossProfitUsd.toString(),
        this.snapshotValue(snapshot, 'commissionProfitUsd'),
        this.snapshotValue(snapshot, 'remainingNegativeProfitUsd'),
        this.snapshotValue(snapshot, 'baseSalaryRmb'),
        this.snapshotValue(snapshot, 'starAllowanceRmb'),
        this.snapshotValue(snapshot, 'commissionRate'),
        this.snapshotValue(snapshot, 'commissionUsd'),
        detail.commissionRmb.toString(),
        this.snapshotValue(snapshot, 'attendanceBonusRmb'),
        detail.manualAdditionRmb.toString(),
        detail.manualDeductionRmb.toString(),
        detail.finalSalaryRmb.toString(),
        this.snapshotValue(snapshot, 'salaryMode'),
        this.snapshotValue(snapshot, 'groupId'),
      ];
    });

    const csv = [header, ...rows].map((row) => row.map((value) => this.escapeCsv(value)).join(',')).join('\n');

    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'salary.export',
      objectType: 'monthly_settlement',
      objectId: settlement.id,
      settlementMonth,
      afterData: {
        settlementMonth: formatSettlementMonth(settlementMonth),
        detailCount: settlement.details.length,
      },
      changedFields: [],
      requestPayload: { settlementMonth: formatSettlementMonth(settlementMonth), format: 'csv' },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return csv;
  }

  private async rollForwardNegativeProfits(settlement: SettlementWithDetails, actor: Actor) {
    const nextMonth = nextSettlementMonth(settlement.settlementMonth);
    const reason = `Auto roll-forward from locked settlement ${formatSettlementMonth(settlement.settlementMonth)}`;
    let createdCount = 0;
    let updatedCount = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const detail of settlement.details) {
        const amountUsd = this.remainingNegativeProfitUsd(detail);
        if (amountUsd.lte(ZERO)) {
          continue;
        }

        const existing = await tx.historicalNegativeProfit.findFirst({
          where: {
            settlementMonth: nextMonth,
            employeeId: detail.employeeId,
            reason,
            status: { in: [CommonStatus.active, CommonStatus.confirmed] },
          },
        });

        if (existing) {
          await tx.historicalNegativeProfit.update({
            where: { id: existing.id },
            data: { amountUsd },
          });
          updatedCount += 1;
        } else {
          await tx.historicalNegativeProfit.create({
            data: {
              settlementMonth: nextMonth,
              employeeId: detail.employeeId,
              amountUsd,
              reason,
              status: CommonStatus.active,
              createdBy: actor.userId,
            },
          });
          createdCount += 1;
        }
      }

      await this.audit.success(
        {
          actorUserId: actor.userId,
          actorRole: actor.roleCode,
          action: ROLL_FORWARD_ACTION,
          objectType: 'historical_negative_profit',
          objectId: settlement.id,
          settlementMonth: settlement.settlementMonth,
          afterData: {
            nextMonth: formatSettlementMonth(nextMonth),
            createdCount,
            updatedCount,
          },
          changedFields: ['amountUsd'],
          requestPayload: {
            settlementMonth: formatSettlementMonth(settlement.settlementMonth),
            nextMonth: formatSettlementMonth(nextMonth),
            reason,
          },
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        },
        tx,
      );
    });

    return {
      nextMonth,
      createdCount,
      updatedCount,
    };
  }

  private assertConfirmable(settlement: SettlementWithDetails | null): asserts settlement is SettlementWithDetails {
    if (!settlement) {
      throw new AppError(ERROR_CODES.SETTLEMENT_NOT_FOUND, 'Settlement not found.');
    }
    if (settlement.status !== SettlementStatus.draft) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Only draft settlement can be confirmed.');
    }
    if (settlement.details.length === 0) {
      throw new AppError(ERROR_CODES.SETTLEMENT_PRECHECK_FAILED, 'Settlement must have details before confirmation.');
    }
  }

  private assertLockable(settlement: SettlementWithDetails | null): asserts settlement is SettlementWithDetails {
    if (!settlement) {
      throw new AppError(ERROR_CODES.SETTLEMENT_NOT_FOUND, 'Settlement not found.');
    }
    if (settlement.status !== SettlementStatus.confirmed) {
      throw new AppError(ERROR_CODES.SETTLEMENT_PRECHECK_FAILED, 'Only confirmed settlement can be locked.');
    }
    if (settlement.details.length === 0) {
      throw new AppError(ERROR_CODES.SETTLEMENT_PRECHECK_FAILED, 'Settlement must have details before lock.');
    }
  }

  private remainingNegativeProfitUsd(detail: SettlementDetail): Prisma.Decimal {
    const value = this.snapshotValue(this.snapshot(detail), 'remainingNegativeProfitUsd');
    return value ? new Prisma.Decimal(value) : ZERO;
  }

  private snapshot(detail: SettlementDetail): Record<string, unknown> {
    return (detail.snapshot ?? {}) as Record<string, unknown>;
  }

  private snapshotValue(snapshot: Record<string, unknown>, key: string): string {
    const value = snapshot[key];
    if (value === null || value === undefined) return '';
    return String(value);
  }

  private serializeSettlement(settlement: Omit<SettlementWithDetails, 'details'> & { details?: SettlementDetail[] }) {
    return {
      id: settlement.id,
      settlementMonth: settlement.settlementMonth,
      status: settlement.status,
      generatedAt: settlement.generatedAt,
      generatedBy: settlement.generatedBy,
      confirmedAt: settlement.confirmedAt,
      confirmedBy: settlement.confirmedBy,
      lockedAt: settlement.lockedAt,
      lockedBy: settlement.lockedBy,
      lockReason: settlement.lockReason,
    };
  }

  private serializeDetail(detail: SettlementDetail) {
    return {
      employeeId: detail.employeeId,
      incomeUsd: detail.incomeUsd.toString(),
      cardSpendUsd: detail.cardSpendUsd.toString(),
      grossProfitUsd: detail.grossProfitUsd.toString(),
      commissionRmb: detail.commissionRmb.toString(),
      manualAdditionRmb: detail.manualAdditionRmb.toString(),
      manualDeductionRmb: detail.manualDeductionRmb.toString(),
      finalSalaryRmb: detail.finalSalaryRmb.toString(),
      attendanceStatus: detail.attendanceStatus,
      snapshot: detail.snapshot,
    };
  }

  private sum(values: Prisma.Decimal[]): Prisma.Decimal {
    return values.reduce((total, value) => total.plus(value), ZERO);
  }

  private parsePositiveInt(value: string | number | undefined, fallback: number, field: string): number {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a positive integer.`);
    }
    return parsed;
  }

  private escapeCsv(value: unknown): string {
    const text = value === null || value === undefined ? '' : String(value);
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }
}
