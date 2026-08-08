import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor, ListQuery } from '../base-data/base-data.types';
import {
  changedFields,
  duplicateResource,
  isDuplicateError,
  notFound,
  optionalNonBlank,
  parseDecimalString,
  parseMonthStart,
  requireNonBlank,
} from '../base-data/base-data.utils';
import { assertOptionalStatus, auditInput } from '../base-data/manual-entry.utils';
import { AppError } from '../common/app-error';
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';

const INCOME_STATUSES = [CommonStatus.draft, CommonStatus.confirmed, CommonStatus.disabled] as const;

export type CreateManualIncomeRecordInput = {
  settlementMonth: string | Date;
  source: string;
  incomeUsd: string;
  employeeId?: string;
  affiliateAccountId?: string;
  subField?: string;
  subValue?: string;
  externalRecordId?: string;
  rawData?: Prisma.InputJsonValue;
  status?: CommonStatus;
};

export type UpdateManualIncomeRecordInput = Partial<CreateManualIncomeRecordInput>;

@Injectable()
export class ManualIncomeRecordsService {
  readonly requiredPermission = 'income.import';

  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateManualIncomeRecordInput, actor: Actor) {
    const data = this.validateCreate(input);
    this.assertConfirmedHasEmployee(data.status, data.employeeId);
    await this.assertWritable(data.settlementMonth, 'manual_income_record.create', undefined, input, actor);

    try {
      const record = await this.prisma.incomeRecord.create({
        data: { ...data, importedBy: actor.userId },
      });
      await this.audit.success(
        auditInput({
          actor,
          action: 'manual_income_record.create',
          objectType: 'income_records',
          objectId: record.id,
          settlementMonth: record.settlementMonth,
          afterData: record,
          changedFields: Object.keys(data),
          requestPayload: input,
        }),
      );
      return record;
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('source + externalRecordId already exists.');
      throw error;
    }
  }

  async list(query: ListQuery = {}) {
    return this.prisma.incomeRecord.findMany({
      where: {
        status: query.status as CommonStatus | undefined,
        employeeId: query.employeeId,
        settlementMonth: query.settlementMonth ? parseMonthStart(query.settlementMonth, 'settlementMonth') : undefined,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const record = await this.prisma.incomeRecord.findUnique({ where: { id } });
    if (!record) throw notFound('Manual income record');
    return record;
  }

  async update(id: string, input: UpdateManualIncomeRecordInput, actor: Actor) {
    const before = await this.get(id);
    const data = this.validateUpdate(input);
    const nextSettlementMonth = (data.settlementMonth as Date | undefined) ?? before.settlementMonth;
    const nextStatus = (data.status as CommonStatus | undefined) ?? before.status;
    const nextEmployeeId =
      data.employeeId === undefined ? before.employeeId : (data.employeeId as string | null | undefined) ?? null;
    this.assertConfirmedHasEmployee(nextStatus, nextEmployeeId);

    await this.assertWritable(before.settlementMonth, 'manual_income_record.update', id, input, actor);
    if (nextSettlementMonth.getTime() !== before.settlementMonth.getTime()) {
      await this.assertWritable(nextSettlementMonth, 'manual_income_record.update', id, input, actor);
    }

    try {
      const after = await this.prisma.incomeRecord.update({ where: { id }, data });
      await this.audit.success(
        auditInput({
          actor,
          action: 'manual_income_record.update',
          objectType: 'income_records',
          objectId: id,
          settlementMonth: after.settlementMonth,
          beforeData: before,
          afterData: after,
          changedFields: changedFields(before as never, after as never, Object.keys(data)),
          requestPayload: input,
        }),
      );
      return after;
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('source + externalRecordId already exists.');
      throw error;
    }
  }

  async confirm(id: string, actor: Actor) {
    const before = await this.get(id);
    this.assertConfirmedHasEmployee(CommonStatus.confirmed, before.employeeId);
    await this.assertWritable(before.settlementMonth, 'manual_income_record.confirm', id, { id }, actor);
    const after = await this.prisma.incomeRecord.update({
      where: { id },
      data: { status: CommonStatus.confirmed },
    });
    await this.audit.success(
      auditInput({
        actor,
        action: 'manual_income_record.confirm',
        objectType: 'income_records',
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

  async disable(id: string, actor: Actor) {
    const before = await this.get(id);
    await this.assertWritable(before.settlementMonth, 'manual_income_record.disable', id, { id }, actor);
    const after = await this.prisma.incomeRecord.update({
      where: { id },
      data: { status: CommonStatus.disabled },
    });
    await this.audit.success(
      auditInput({
        actor,
        action: 'manual_income_record.disable',
        objectType: 'income_records',
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

  private validateCreate(input: CreateManualIncomeRecordInput) {
    const incomeUsd = parseDecimalString(input.incomeUsd, 'incomeUsd');
    this.assertNonNegativeIncome(incomeUsd);
    return {
      settlementMonth: parseMonthStart(input.settlementMonth, 'settlementMonth'),
      source: requireNonBlank(input.source, 'source'),
      incomeUsd,
      employeeId: optionalNonBlank(input.employeeId, 'employeeId'),
      affiliateAccountId: optionalNonBlank(input.affiliateAccountId, 'affiliateAccountId'),
      subField: optionalNonBlank(input.subField, 'subField'),
      subValue: optionalNonBlank(input.subValue, 'subValue'),
      externalRecordId: optionalNonBlank(input.externalRecordId, 'externalRecordId'),
      rawData: input.rawData,
      status: assertOptionalStatus(input.status, INCOME_STATUSES) ?? CommonStatus.draft,
    };
  }

  private validateUpdate(input: UpdateManualIncomeRecordInput) {
    const data: Record<string, unknown> = {};
    if (input.settlementMonth !== undefined) data.settlementMonth = parseMonthStart(input.settlementMonth, 'settlementMonth');
    if (input.source !== undefined) data.source = requireNonBlank(input.source, 'source');
    if (input.incomeUsd !== undefined) {
      const incomeUsd = parseDecimalString(input.incomeUsd, 'incomeUsd');
      this.assertNonNegativeIncome(incomeUsd);
      data.incomeUsd = incomeUsd;
    }
    if (input.employeeId !== undefined) data.employeeId = optionalNonBlank(input.employeeId, 'employeeId') ?? null;
    if (input.affiliateAccountId !== undefined) data.affiliateAccountId = optionalNonBlank(input.affiliateAccountId, 'affiliateAccountId') ?? null;
    if (input.subField !== undefined) data.subField = optionalNonBlank(input.subField, 'subField') ?? null;
    if (input.subValue !== undefined) data.subValue = optionalNonBlank(input.subValue, 'subValue') ?? null;
    if (input.externalRecordId !== undefined) data.externalRecordId = optionalNonBlank(input.externalRecordId, 'externalRecordId') ?? null;
    if (input.rawData !== undefined) data.rawData = input.rawData;
    if (input.status !== undefined) data.status = assertOptionalStatus(input.status, INCOME_STATUSES);
    return data;
  }

  private assertNonNegativeIncome(incomeUsd: Prisma.Decimal): void {
    if (incomeUsd.isNegative()) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        '普通手动收入不能为负数；CAKE月度SUB差额只能通过专用调整功能录入。',
      );
    }
  }

  private assertConfirmedHasEmployee(status: CommonStatus, employeeId?: string | null): void {
    if (status === CommonStatus.confirmed && !employeeId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'employeeId is required when status is confirmed.');
    }
  }

  private async assertWritable(
    settlementMonth: Date,
    action: string,
    objectId: string | undefined,
    requestPayload: unknown,
    actor: Actor,
  ) {
    await this.monthLock.assertWritable(
      { settlementMonth, action, objectType: 'income_records', objectId, requestPayload },
      actor,
    );
  }
}
