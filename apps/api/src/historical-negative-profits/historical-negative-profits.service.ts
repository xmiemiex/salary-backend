import { Injectable } from '@nestjs/common';
import { CommonStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { Actor, ListQuery } from '../base-data/base-data.types';
import {
  changedFields,
  notFound,
  optionalNonBlank,
  parseDecimalString,
  parseMonthStart,
  requireNonBlank,
} from '../base-data/base-data.utils';
import { assertOptionalStatus, auditInput } from '../base-data/manual-entry.utils';
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';

const HISTORICAL_NEGATIVE_PROFIT_STATUSES = [CommonStatus.active, CommonStatus.disabled] as const;

export type CreateHistoricalNegativeProfitInput = {
  settlementMonth: string | Date;
  employeeId: string;
  amountUsd: string;
  reason?: string;
  status?: CommonStatus;
};

export type UpdateHistoricalNegativeProfitInput = Partial<CreateHistoricalNegativeProfitInput>;

@Injectable()
export class HistoricalNegativeProfitsService {
  readonly requiredPermission = 'historical_negative_profit.manage';

  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateHistoricalNegativeProfitInput, actor: Actor) {
    const data = this.validateCreate(input);
    await this.assertWritable(data.settlementMonth, 'historical_negative_profit.create', undefined, input, actor);
    const profit = await this.prisma.historicalNegativeProfit.create({ data: { ...data, createdBy: actor.userId } });
    await this.audit.success(
      auditInput({
        actor,
        action: 'historical_negative_profit.create',
        objectType: 'historical_negative_profits',
        objectId: profit.id,
        settlementMonth: profit.settlementMonth,
        afterData: profit,
        changedFields: Object.keys(data),
        requestPayload: input,
      }),
    );
    return profit;
  }

  async list(query: ListQuery = {}) {
    return this.prisma.historicalNegativeProfit.findMany({
      where: {
        status: query.status as CommonStatus | undefined,
        employeeId: query.employeeId,
        settlementMonth: query.settlementMonth ? parseMonthStart(query.settlementMonth, 'settlementMonth') : undefined,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const profit = await this.prisma.historicalNegativeProfit.findUnique({ where: { id } });
    if (!profit) throw notFound('Historical negative profit');
    return profit;
  }

  async update(id: string, input: UpdateHistoricalNegativeProfitInput, actor: Actor) {
    const before = await this.get(id);
    const data = this.validateUpdate(input);
    await this.assertWritable(before.settlementMonth, 'historical_negative_profit.update', id, input, actor);
    const nextSettlementMonth = (data.settlementMonth as Date | undefined) ?? before.settlementMonth;
    if (nextSettlementMonth.getTime() !== before.settlementMonth.getTime()) {
      await this.assertWritable(nextSettlementMonth, 'historical_negative_profit.update', id, input, actor);
    }
    const after = await this.prisma.historicalNegativeProfit.update({ where: { id }, data });
    await this.audit.success(
      auditInput({
        actor,
        action: 'historical_negative_profit.update',
        objectType: 'historical_negative_profits',
        objectId: id,
        settlementMonth: after.settlementMonth,
        beforeData: before,
        afterData: after,
        changedFields: changedFields(before as never, after as never, Object.keys(data)),
        requestPayload: input,
      }),
    );
    return after;
  }

  async disable(id: string, actor: Actor) {
    const before = await this.get(id);
    await this.assertWritable(before.settlementMonth, 'historical_negative_profit.disable', id, { id }, actor);
    const after = await this.prisma.historicalNegativeProfit.update({
      where: { id },
      data: { status: CommonStatus.disabled },
    });
    await this.audit.success(
      auditInput({
        actor,
        action: 'historical_negative_profit.disable',
        objectType: 'historical_negative_profits',
        objectId: id,
        settlementMonth: before.settlementMonth,
        beforeData: before,
        afterData: after,
        changedFields: ['status'],
        requestPayload: { id },
      }),
    );
    return after;
  }

  private validateCreate(input: CreateHistoricalNegativeProfitInput) {
    return {
      settlementMonth: parseMonthStart(input.settlementMonth, 'settlementMonth'),
      employeeId: requireNonBlank(input.employeeId, 'employeeId'),
      amountUsd: parseDecimalString(input.amountUsd, 'amountUsd'),
      reason: optionalNonBlank(input.reason, 'reason'),
      status: assertOptionalStatus(input.status, HISTORICAL_NEGATIVE_PROFIT_STATUSES) ?? CommonStatus.active,
    };
  }

  private validateUpdate(input: UpdateHistoricalNegativeProfitInput) {
    const data: Record<string, unknown> = {};
    if (input.settlementMonth !== undefined) data.settlementMonth = parseMonthStart(input.settlementMonth, 'settlementMonth');
    if (input.employeeId !== undefined) data.employeeId = requireNonBlank(input.employeeId, 'employeeId');
    if (input.amountUsd !== undefined) data.amountUsd = parseDecimalString(input.amountUsd, 'amountUsd');
    if (input.reason !== undefined) data.reason = optionalNonBlank(input.reason, 'reason') ?? null;
    if (input.status !== undefined) data.status = assertOptionalStatus(input.status, HISTORICAL_NEGATIVE_PROFIT_STATUSES);
    return data;
  }

  private async assertWritable(
    settlementMonth: Date,
    action: string,
    objectId: string | undefined,
    requestPayload: unknown,
    actor: Actor,
  ) {
    await this.monthLock.assertWritable(
      { settlementMonth, action, objectType: 'historical_negative_profits', objectId, requestPayload },
      actor,
    );
  }
}
