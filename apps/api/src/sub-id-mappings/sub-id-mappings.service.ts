import { Injectable } from '@nestjs/common';
import { CommonStatus } from '@prisma/client';
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
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';

export type CreateSubIdMappingInput = {
  affiliateAccountId: string;
  subField: string;
  subValue: string;
  effectiveMonth: string | Date;
  employeeId: string;
  status?: CommonStatus;
};

export type UpdateSubIdMappingInput = Partial<CreateSubIdMappingInput>;

@Injectable()
export class SubIdMappingsService {
  readonly requiredPermission = 'sub_id_mapping.manage';

  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateSubIdMappingInput, actor: Actor) {
    const data = this.validateCreate(input);
    await this.monthLock.assertWritable(
      { settlementMonth: data.effectiveMonth, action: 'sub_id_mapping.create', objectType: 'sub_id_mappings', requestPayload: input },
      actor,
    );
    try {
      const mapping = await this.prisma.subIdMapping.create({ data: { ...data, createdBy: actor.userId } });
      await this.audit.success(this.auditInput(actor, 'sub_id_mapping.create', mapping.id, data.effectiveMonth, undefined, mapping, Object.keys(data), input));
      return mapping;
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('affiliateAccountId + subField + subValue + effectiveMonth already exists.');
      throw error;
    }
  }

  async list(query: ListQuery = {}) {
    return this.prisma.subIdMapping.findMany({
      where: {
        status: query.status as CommonStatus | undefined,
        employeeId: query.employeeId,
        effectiveMonth: query.effectiveMonth ? parseMonthStart(query.effectiveMonth, 'effectiveMonth') : undefined,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const mapping = await this.prisma.subIdMapping.findUnique({ where: { id } });
    if (!mapping) throw notFound('SUB ID mapping');
    return mapping;
  }

  async update(id: string, input: UpdateSubIdMappingInput, actor: Actor) {
    const before = await this.get(id);
    const data = this.validateUpdate(input);
    await this.monthLock.assertWritable(
      { settlementMonth: before.effectiveMonth, action: 'sub_id_mapping.update', objectType: 'sub_id_mappings', objectId: id, requestPayload: input },
      actor,
    );
    if (data.effectiveMonth && formatMonth(data.effectiveMonth as Date) !== formatMonth(before.effectiveMonth)) {
      await this.monthLock.assertWritable(
        { settlementMonth: data.effectiveMonth as Date, action: 'sub_id_mapping.update', objectType: 'sub_id_mappings', objectId: id, requestPayload: input },
        actor,
      );
    }
    try {
      const after = await this.prisma.subIdMapping.update({ where: { id }, data });
      await this.audit.success(
        this.auditInput(
          actor,
          'sub_id_mapping.update',
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
      if (isDuplicateError(error)) throw duplicateResource('affiliateAccountId + subField + subValue + effectiveMonth already exists.');
      throw error;
    }
  }

  async disable(id: string, actor: Actor) {
    const before = await this.get(id);
    await this.monthLock.assertWritable(
      { settlementMonth: before.effectiveMonth, action: 'sub_id_mapping.disable', objectType: 'sub_id_mappings', objectId: id, requestPayload: { id } },
      actor,
    );
    const after = await this.prisma.subIdMapping.update({ where: { id }, data: { status: CommonStatus.disabled } });
    await this.audit.success(this.auditInput(actor, 'sub_id_mapping.disable', id, before.effectiveMonth, before, after, ['status'], { id }));
    return after;
  }

  private validateCreate(input: CreateSubIdMappingInput) {
    return {
      affiliateAccountId: requireNonBlank(input.affiliateAccountId, 'affiliateAccountId'),
      subField: requireNonBlank(input.subField, 'subField'),
      subValue: requireNonBlank(input.subValue, 'subValue'),
      effectiveMonth: parseMonthStart(input.effectiveMonth, 'effectiveMonth'),
      employeeId: requireNonBlank(input.employeeId, 'employeeId'),
      status: input.status ?? CommonStatus.active,
    };
  }

  private validateUpdate(input: UpdateSubIdMappingInput) {
    const data: Record<string, unknown> = {};
    if (input.affiliateAccountId !== undefined) data.affiliateAccountId = requireNonBlank(input.affiliateAccountId, 'affiliateAccountId');
    if (input.subField !== undefined) data.subField = requireNonBlank(input.subField, 'subField');
    if (input.subValue !== undefined) data.subValue = requireNonBlank(input.subValue, 'subValue');
    if (input.effectiveMonth !== undefined) data.effectiveMonth = parseMonthStart(input.effectiveMonth, 'effectiveMonth');
    if (input.employeeId !== undefined) data.employeeId = requireNonBlank(input.employeeId, 'employeeId');
    if (input.status !== undefined) data.status = input.status;
    return data;
  }

  private auditInput(actor: Actor, action: string, objectId: string, settlementMonth: Date, beforeData: unknown, afterData: unknown, fields: string[], requestPayload: unknown) {
    return { actorUserId: actor.userId, actorRole: actor.roleCode, action, objectType: 'sub_id_mappings', objectId, settlementMonth, beforeData, afterData, changedFields: fields, requestPayload, ipAddress: actor.ipAddress, userAgent: actor.userAgent };
  }
}
