import { Injectable } from '@nestjs/common';
import { CommonStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { Actor, ListQuery } from '../base-data/base-data.types';
import {
  changedFields,
  duplicateResource,
  isDuplicateError,
  notFound,
  parseDecimalString,
  parseMonthStart,
} from '../base-data/base-data.utils';
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';

export type CreateMonthlyExchangeRateInput = {
  settlementMonth: string | Date;
  usdToRmbRate: string;
  status?: CommonStatus;
};

export type UpdateMonthlyExchangeRateInput = Partial<CreateMonthlyExchangeRateInput>;

@Injectable()
export class MonthlyExchangeRatesService {
  readonly requiredPermission = 'monthly_exchange_rate.manage';

  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateMonthlyExchangeRateInput, actor: Actor) {
    const data = this.validateCreate(input);
    await this.monthLock.assertWritable(
      { settlementMonth: data.settlementMonth, action: 'monthly_exchange_rate.create', objectType: 'monthly_exchange_rates', requestPayload: input },
      actor,
    );
    try {
      const rate = await this.prisma.monthlyExchangeRate.create({ data: { ...data, createdBy: actor.userId } });
      await this.audit.success(this.auditInput(actor, 'monthly_exchange_rate.create', rate.id, data.settlementMonth, undefined, rate, Object.keys(data), input));
      return rate;
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('settlementMonth already exists.');
      throw error;
    }
  }

  async list(query: ListQuery = {}) {
    return this.prisma.monthlyExchangeRate.findMany({
      where: {
        status: query.status as CommonStatus | undefined,
        settlementMonth: query.settlementMonth ? parseMonthStart(query.settlementMonth, 'settlementMonth') : undefined,
      },
      orderBy: { settlementMonth: 'desc' },
    });
  }

  async get(id: string) {
    const rate = await this.prisma.monthlyExchangeRate.findUnique({ where: { id } });
    if (!rate) throw notFound('Monthly exchange rate');
    return rate;
  }

  async update(id: string, input: UpdateMonthlyExchangeRateInput, actor: Actor) {
    const before = await this.get(id);
    const data = this.validateUpdate(input);
    await this.monthLock.assertWritable(
      { settlementMonth: before.settlementMonth, action: 'monthly_exchange_rate.update', objectType: 'monthly_exchange_rates', objectId: id, requestPayload: input },
      actor,
    );
    if (data.settlementMonth) {
      await this.monthLock.assertWritable(
        { settlementMonth: data.settlementMonth as Date, action: 'monthly_exchange_rate.update', objectType: 'monthly_exchange_rates', objectId: id, requestPayload: input },
        actor,
      );
    }
    try {
      const after = await this.prisma.monthlyExchangeRate.update({ where: { id }, data });
      await this.audit.success(
        this.auditInput(
          actor,
          'monthly_exchange_rate.update',
          id,
          after.settlementMonth,
          before,
          after,
          changedFields(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, Object.keys(data)),
          input,
        ),
      );
      return after;
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('settlementMonth already exists.');
      throw error;
    }
  }

  async disable(id: string, actor: Actor) {
    const before = await this.get(id);
    await this.monthLock.assertWritable(
      { settlementMonth: before.settlementMonth, action: 'monthly_exchange_rate.disable', objectType: 'monthly_exchange_rates', objectId: id, requestPayload: { id } },
      actor,
    );
    const after = await this.prisma.monthlyExchangeRate.update({ where: { id }, data: { status: CommonStatus.disabled } });
    await this.audit.success(this.auditInput(actor, 'monthly_exchange_rate.disable', id, before.settlementMonth, before, after, ['status'], { id }));
    return after;
  }

  private validateCreate(input: CreateMonthlyExchangeRateInput) {
    return {
      settlementMonth: parseMonthStart(input.settlementMonth, 'settlementMonth'),
      usdToRmbRate: parseDecimalString(input.usdToRmbRate, 'usdToRmbRate', { gtZero: true }),
      status: input.status ?? CommonStatus.active,
    };
  }

  private validateUpdate(input: UpdateMonthlyExchangeRateInput) {
    const data: Record<string, unknown> = {};
    if (input.settlementMonth !== undefined) data.settlementMonth = parseMonthStart(input.settlementMonth, 'settlementMonth');
    if (input.usdToRmbRate !== undefined) data.usdToRmbRate = parseDecimalString(input.usdToRmbRate, 'usdToRmbRate', { gtZero: true });
    if (input.status !== undefined) data.status = input.status;
    return data;
  }

  private auditInput(actor: Actor, action: string, objectId: string, settlementMonth: Date, beforeData: unknown, afterData: unknown, fields: string[], requestPayload: unknown) {
    return { actorUserId: actor.userId, actorRole: actor.roleCode, action, objectType: 'monthly_exchange_rates', objectId, settlementMonth, beforeData, afterData, changedFields: fields, requestPayload, ipAddress: actor.ipAddress, userAgent: actor.userAgent };
  }
}
