import { Injectable } from '@nestjs/common';
import { CommonStatus, Provider } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor, ListQuery } from '../base-data/base-data.types';
import {
  changedFields,
  duplicateResource,
  formatMonth,
  isDuplicateError,
  notFound,
  parseMonthStart,
  requireNonBlank,
} from '../base-data/base-data.utils';
import { AppError } from '../common/app-error';
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';

export type CreateCardBindingInput = {
  provider: Provider;
  cardId: string;
  effectiveMonth: string | Date;
  employeeId: string;
  status?: CommonStatus;
};

export type UpdateCardBindingInput = Partial<CreateCardBindingInput>;

@Injectable()
export class CardBindingsService {
  readonly requiredPermission = 'card_binding.manage';

  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateCardBindingInput, actor: Actor) {
    const data = this.validateCreate(input);
    await this.monthLock.assertWritable(
      { settlementMonth: data.effectiveMonth, action: 'card_binding.create', objectType: 'card_bindings', requestPayload: input },
      actor,
    );
    try {
      const binding = await this.prisma.cardBinding.create({ data: { ...data, createdBy: actor.userId } });
      await this.audit.success(this.auditInput(actor, 'card_binding.create', binding.id, data.effectiveMonth, undefined, binding, Object.keys(data), input));
      return binding;
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('provider + cardId + effectiveMonth already exists.');
      throw error;
    }
  }

  async list(query: ListQuery = {}) {
    return this.prisma.cardBinding.findMany({
      where: {
        status: query.status as CommonStatus | undefined,
        employeeId: query.employeeId,
        provider: query.provider as Provider | undefined,
        effectiveMonth: query.effectiveMonth ? parseMonthStart(query.effectiveMonth, 'effectiveMonth') : undefined,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const binding = await this.prisma.cardBinding.findUnique({ where: { id } });
    if (!binding) throw notFound('Card binding');
    return binding;
  }

  async update(id: string, input: UpdateCardBindingInput, actor: Actor) {
    const before = await this.get(id);
    const data = this.validateUpdate(input);
    await this.monthLock.assertWritable(
      { settlementMonth: before.effectiveMonth, action: 'card_binding.update', objectType: 'card_bindings', objectId: id, requestPayload: input },
      actor,
    );
    if (data.effectiveMonth && formatMonth(data.effectiveMonth as Date) !== formatMonth(before.effectiveMonth)) {
      await this.monthLock.assertWritable(
        { settlementMonth: data.effectiveMonth as Date, action: 'card_binding.update', objectType: 'card_bindings', objectId: id, requestPayload: input },
        actor,
      );
    }
    try {
      const after = await this.prisma.cardBinding.update({ where: { id }, data });
      await this.audit.success(
        this.auditInput(
          actor,
          'card_binding.update',
          id,
          after.effectiveMonth,
          before,
          after,
          changedFields(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, Object.keys(data)),
          input,
        ),
      );
      return after;
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('provider + cardId + effectiveMonth already exists.');
      throw error;
    }
  }

  async disable(id: string, actor: Actor) {
    const before = await this.get(id);
    await this.monthLock.assertWritable(
      { settlementMonth: before.effectiveMonth, action: 'card_binding.disable', objectType: 'card_bindings', objectId: id, requestPayload: { id } },
      actor,
    );
    const after = await this.prisma.cardBinding.update({ where: { id }, data: { status: CommonStatus.disabled } });
    await this.audit.success(this.auditInput(actor, 'card_binding.disable', id, before.effectiveMonth, before, after, ['status'], { id }));
    return after;
  }

  private validateCreate(input: CreateCardBindingInput) {
    return {
      provider: this.validateProvider(input.provider),
      cardId: requireNonBlank(input.cardId, 'cardId'),
      effectiveMonth: parseMonthStart(input.effectiveMonth, 'effectiveMonth'),
      employeeId: requireNonBlank(input.employeeId, 'employeeId'),
      status: input.status ?? CommonStatus.active,
    };
  }

  private validateUpdate(input: UpdateCardBindingInput) {
    const data: Record<string, unknown> = {};
    if (input.provider !== undefined) data.provider = this.validateProvider(input.provider);
    if (input.cardId !== undefined) data.cardId = requireNonBlank(input.cardId, 'cardId');
    if (input.effectiveMonth !== undefined) data.effectiveMonth = parseMonthStart(input.effectiveMonth, 'effectiveMonth');
    if (input.employeeId !== undefined) data.employeeId = requireNonBlank(input.employeeId, 'employeeId');
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
    return { actorUserId: actor.userId, actorRole: actor.roleCode, action, objectType: 'card_bindings', objectId, settlementMonth, beforeData, afterData, changedFields: fields, requestPayload, ipAddress: actor.ipAddress, userAgent: actor.userAgent };
  }
}
