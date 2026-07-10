import { Injectable } from '@nestjs/common';
import { CommonStatus, SalaryItemType } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor, ListQuery } from '../base-data/base-data.types';
import {
  changedFields,
  duplicateResource,
  isDuplicateError,
  notFound,
  optionalNonBlank,
  requireNonBlank,
} from '../base-data/base-data.utils';
import { assertOptionalStatus, auditInput } from '../base-data/manual-entry.utils';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';

const CONFIG_STATUSES = [CommonStatus.active, CommonStatus.disabled] as const;

export type CreateSalaryItemConfigInput = {
  code: string;
  name: string;
  itemType: SalaryItemType;
  description?: string;
  status?: CommonStatus;
};

export type UpdateSalaryItemConfigInput = Partial<CreateSalaryItemConfigInput>;

@Injectable()
export class SalaryItemConfigsService {
  readonly requiredPermission = 'salary_item_config.manage';

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateSalaryItemConfigInput, actor: Actor) {
    const data = this.validateCreate(input);
    try {
      const config = await this.prisma.salaryItemConfig.create({ data: { ...data, createdBy: actor.userId } });
      await this.audit.success(
        auditInput({
          actor,
          action: 'salary_item_config.create',
          objectType: 'salary_item_configs',
          objectId: config.id,
          afterData: config,
          changedFields: Object.keys(data),
          requestPayload: input,
        }),
      );
      return config;
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('code already exists.');
      throw error;
    }
  }

  async list(query: ListQuery = {}) {
    return this.prisma.salaryItemConfig.findMany({
      where: { status: query.status as CommonStatus | undefined },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const config = await this.prisma.salaryItemConfig.findUnique({ where: { id } });
    if (!config) throw notFound('Salary item config');
    return config;
  }

  async update(id: string, input: UpdateSalaryItemConfigInput, actor: Actor) {
    const before = await this.get(id);
    const data = this.validateUpdate(input);
    try {
      const after = await this.prisma.salaryItemConfig.update({ where: { id }, data });
      await this.audit.success(
        auditInput({
          actor,
          action: 'salary_item_config.update',
          objectType: 'salary_item_configs',
          objectId: id,
          beforeData: before,
          afterData: after,
          changedFields: changedFields(before as never, after as never, Object.keys(data)),
          requestPayload: input,
        }),
      );
      return after;
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('code already exists.');
      throw error;
    }
  }

  async disable(id: string, actor: Actor) {
    const before = await this.get(id);
    const after = await this.prisma.salaryItemConfig.update({
      where: { id },
      data: { status: CommonStatus.disabled },
    });
    await this.audit.success(
      auditInput({
        actor,
        action: 'salary_item_config.disable',
        objectType: 'salary_item_configs',
        objectId: id,
        beforeData: before,
        afterData: after,
        changedFields: ['status'],
        requestPayload: { id },
      }),
    );
    return after;
  }

  private validateCreate(input: CreateSalaryItemConfigInput) {
    return {
      code: requireNonBlank(input.code, 'code'),
      name: requireNonBlank(input.name, 'name'),
      itemType: this.validateItemType(input.itemType),
      description: optionalNonBlank(input.description, 'description'),
      status: assertOptionalStatus(input.status, CONFIG_STATUSES) ?? CommonStatus.active,
    };
  }

  private validateUpdate(input: UpdateSalaryItemConfigInput) {
    const data: Record<string, unknown> = {};
    if (input.code !== undefined) data.code = requireNonBlank(input.code, 'code');
    if (input.name !== undefined) data.name = requireNonBlank(input.name, 'name');
    if (input.itemType !== undefined) data.itemType = this.validateItemType(input.itemType);
    if (input.description !== undefined) data.description = optionalNonBlank(input.description, 'description') ?? null;
    if (input.status !== undefined) data.status = assertOptionalStatus(input.status, CONFIG_STATUSES);
    return data;
  }

  private validateItemType(value: unknown): SalaryItemType {
    if (value !== SalaryItemType.addition && value !== SalaryItemType.deduction) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'itemType must be addition or deduction.');
    }
    return value;
  }
}
