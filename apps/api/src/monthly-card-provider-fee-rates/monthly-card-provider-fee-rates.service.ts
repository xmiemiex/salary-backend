import { Injectable } from '@nestjs/common';
import { CommonStatus, Provider } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
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
import { AppError } from '../common/app-error';
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';

export type CreateMonthlyCardProviderFeeRateInput = {
  settlementMonth: string | Date;
  provider: Provider;
  feeRate: string;
  status?: CommonStatus;
};

export type UpdateMonthlyCardProviderFeeRateInput = Partial<CreateMonthlyCardProviderFeeRateInput>;

@Injectable()
export class MonthlyCardProviderFeeRatesService {
  readonly requiredPermission = 'card_provider_fee_rate.manage';

  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateMonthlyCardProviderFeeRateInput, actor: Actor) {
    const data = this.validateCreate(input);
    await this.monthLock.assertWritable(
      { settlementMonth: data.settlementMonth, action: 'monthly_card_provider_fee_rate.create', objectType: 'monthly_card_provider_fee_rates', requestPayload: input },
      actor,
    );
    try {
      const rate = await this.prisma.monthlyCardProviderFeeRate.create({ data: { ...data, createdBy: actor.userId } });
      await this.audit.success(this.auditInput(actor, 'monthly_card_provider_fee_rate.create', rate.id, data.settlementMonth, undefined, rate, Object.keys(data), input));
      return rate;
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('settlementMonth + provider already exists.');
      throw error;
    }
  }

  async list(query: ListQuery = {}) {
    return this.prisma.monthlyCardProviderFeeRate.findMany({
      where: {
        status: query.status as CommonStatus | undefined,
        provider: query.provider as Provider | undefined,
        settlementMonth: query.settlementMonth ? parseMonthStart(query.settlementMonth, 'settlementMonth') : undefined,
      },
      orderBy: { settlementMonth: 'desc' },
    });
  }

  async get(id: string) {
    const rate = await this.prisma.monthlyCardProviderFeeRate.findUnique({ where: { id } });
    if (!rate) throw notFound('Monthly card provider fee rate');
    return rate;
  }

  async update(id: string, input: UpdateMonthlyCardProviderFeeRateInput, actor: Actor) {
    const before = await this.get(id);
    const data = this.validateUpdate(input);
    await this.monthLock.assertWritable(
      { settlementMonth: before.settlementMonth, action: 'monthly_card_provider_fee_rate.update', objectType: 'monthly_card_provider_fee_rates', objectId: id, requestPayload: input },
      actor,
    );
    if (data.settlementMonth) {
      await this.monthLock.assertWritable(
        { settlementMonth: data.settlementMonth as Date, action: 'monthly_card_provider_fee_rate.update', objectType: 'monthly_card_provider_fee_rates', objectId: id, requestPayload: input },
        actor,
      );
    }
    try {
      const after = await this.prisma.monthlyCardProviderFeeRate.update({ where: { id }, data });
      await this.audit.success(
        this.auditInput(
          actor,
          'monthly_card_provider_fee_rate.update',
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
      if (isDuplicateError(error)) throw duplicateResource('settlementMonth + provider already exists.');
      throw error;
    }
  }

  async disable(id: string, actor: Actor) {
    const before = await this.get(id);
    await this.monthLock.assertWritable(
      { settlementMonth: before.settlementMonth, action: 'monthly_card_provider_fee_rate.disable', objectType: 'monthly_card_provider_fee_rates', objectId: id, requestPayload: { id } },
      actor,
    );
    const after = await this.prisma.monthlyCardProviderFeeRate.update({ where: { id }, data: { status: CommonStatus.disabled } });
    await this.audit.success(this.auditInput(actor, 'monthly_card_provider_fee_rate.disable', id, before.settlementMonth, before, after, ['status'], { id }));
    return after;
  }

  private validateCreate(input: CreateMonthlyCardProviderFeeRateInput) {
    return {
      settlementMonth: parseMonthStart(input.settlementMonth, 'settlementMonth'),
      provider: this.validateProvider(input.provider),
      feeRate: parseDecimalString(input.feeRate, 'feeRate'),
      status: input.status ?? CommonStatus.active,
    };
  }

  private validateUpdate(input: UpdateMonthlyCardProviderFeeRateInput) {
    const data: Record<string, unknown> = {};
    if (input.settlementMonth !== undefined) data.settlementMonth = parseMonthStart(input.settlementMonth, 'settlementMonth');
    if (input.provider !== undefined) data.provider = this.validateProvider(input.provider);
    if (input.feeRate !== undefined) data.feeRate = parseDecimalString(input.feeRate, 'feeRate');
    if (input.status !== undefined) data.status = input.status;
    return data;
  }

  private validateProvider(provider: Provider): Provider {
    if (provider !== Provider.airwallex && provider !== Provider.photonpay) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'provider must be airwallex or photonpay.');
    }
    return provider;
  }

  private auditInput(actor: Actor, action: string, objectId: string, settlementMonth: Date, beforeData: unknown, afterData: unknown, fields: string[], requestPayload: unknown) {
    return { actorUserId: actor.userId, actorRole: actor.roleCode, action, objectType: 'monthly_card_provider_fee_rates', objectId, settlementMonth, beforeData, afterData, changedFields: fields, requestPayload, ipAddress: actor.ipAddress, userAgent: actor.userAgent };
  }
}
