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

const MANUAL_ITEM_STATUSES = [CommonStatus.active, CommonStatus.confirmed, CommonStatus.disabled] as const;

export type CreateMonthlySalaryManualItemInput = {
  settlementMonth: string | Date;
  employeeId: string;
  configId: string;
  amountRmb: string;
  remark?: string;
  status?: CommonStatus;
};

export type UpdateMonthlySalaryManualItemInput = Partial<CreateMonthlySalaryManualItemInput>;

@Injectable()
export class MonthlySalaryManualItemsService {
  readonly requiredPermission = 'salary_manual_item.manage';

  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateMonthlySalaryManualItemInput, actor: Actor) {
    const data = this.validateCreate(input);
    await this.assertWritable(data.settlementMonth, 'monthly_salary_manual_item.create', undefined, input, actor);
    const item = await this.prisma.monthlySalaryManualItem.create({ data: { ...data, createdBy: actor.userId } });
    await this.audit.success(
      auditInput({
        actor,
        action: 'monthly_salary_manual_item.create',
        objectType: 'monthly_salary_manual_items',
        objectId: item.id,
        settlementMonth: item.settlementMonth,
        afterData: item,
        changedFields: Object.keys(data),
        requestPayload: input,
      }),
    );
    return item;
  }

  async list(query: ListQuery = {}) {
    return this.prisma.monthlySalaryManualItem.findMany({
      where: {
        status: query.status as CommonStatus | undefined,
        employeeId: query.employeeId,
        settlementMonth: query.settlementMonth ? parseMonthStart(query.settlementMonth, 'settlementMonth') : undefined,
      },
      include: { config: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const item = await this.prisma.monthlySalaryManualItem.findUnique({
      where: { id },
      include: { config: true },
    });
    if (!item) throw notFound('Monthly salary manual item');
    return item;
  }

  async update(id: string, input: UpdateMonthlySalaryManualItemInput, actor: Actor) {
    const before = await this.get(id);
    const data = this.validateUpdate(input);
    await this.assertWritable(before.settlementMonth, 'monthly_salary_manual_item.update', id, input, actor);
    const nextSettlementMonth = (data.settlementMonth as Date | undefined) ?? before.settlementMonth;
    if (nextSettlementMonth.getTime() !== before.settlementMonth.getTime()) {
      await this.assertWritable(nextSettlementMonth, 'monthly_salary_manual_item.update', id, input, actor);
    }
    const after = await this.prisma.monthlySalaryManualItem.update({ where: { id }, data });
    await this.audit.success(
      auditInput({
        actor,
        action: 'monthly_salary_manual_item.update',
        objectType: 'monthly_salary_manual_items',
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
    await this.assertWritable(before.settlementMonth, 'monthly_salary_manual_item.disable', id, { id }, actor);
    const after = await this.prisma.monthlySalaryManualItem.update({
      where: { id },
      data: { status: CommonStatus.disabled },
    });
    await this.audit.success(
      auditInput({
        actor,
        action: 'monthly_salary_manual_item.disable',
        objectType: 'monthly_salary_manual_items',
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

  private validateCreate(input: CreateMonthlySalaryManualItemInput) {
    return {
      settlementMonth: parseMonthStart(input.settlementMonth, 'settlementMonth'),
      employeeId: requireNonBlank(input.employeeId, 'employeeId'),
      configId: requireNonBlank(input.configId, 'configId'),
      amountRmb: parseDecimalString(input.amountRmb, 'amountRmb'),
      remark: optionalNonBlank(input.remark, 'remark'),
      status: assertOptionalStatus(input.status, MANUAL_ITEM_STATUSES) ?? CommonStatus.active,
    };
  }

  private validateUpdate(input: UpdateMonthlySalaryManualItemInput) {
    const data: Record<string, unknown> = {};
    if (input.settlementMonth !== undefined) data.settlementMonth = parseMonthStart(input.settlementMonth, 'settlementMonth');
    if (input.employeeId !== undefined) data.employeeId = requireNonBlank(input.employeeId, 'employeeId');
    if (input.configId !== undefined) data.configId = requireNonBlank(input.configId, 'configId');
    if (input.amountRmb !== undefined) data.amountRmb = parseDecimalString(input.amountRmb, 'amountRmb');
    if (input.remark !== undefined) data.remark = optionalNonBlank(input.remark, 'remark') ?? null;
    if (input.status !== undefined) data.status = assertOptionalStatus(input.status, MANUAL_ITEM_STATUSES);
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
      { settlementMonth, action, objectType: 'monthly_salary_manual_items', objectId, requestPayload },
      actor,
    );
  }
}
