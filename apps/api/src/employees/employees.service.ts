import { Injectable } from '@nestjs/common';
import { CommonStatus } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor, ListQuery } from '../base-data/base-data.types';
import {
  changedFields,
  duplicateResource,
  isDuplicateError,
  notFound,
  optionalNonBlank,
  parseOptionalDate,
  requireNonBlank,
} from '../base-data/base-data.utils';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';

export type CreateEmployeeInput = {
  employeeCode: string;
  name: string;
  email?: string;
  phone?: string;
  hiredAt?: string | Date;
  leftAt?: string | Date;
  status?: CommonStatus;
};

export type UpdateEmployeeInput = Partial<CreateEmployeeInput>;

@Injectable()
export class EmployeesService {
  readonly requiredPermission = 'employee.manage';

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateEmployeeInput, actor: Actor) {
    const data = this.validateCreate(input);
    try {
      const employee = await this.prisma.employee.create({ data });
      await this.audit.success({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'employee.create',
        objectType: 'employees',
        objectId: employee.id,
        afterData: employee,
        changedFields: Object.keys(data),
        requestPayload: input,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
      return employee;
    } catch (error) {
      if (isDuplicateError(error)) {
        await this.audit.failure({
          actorUserId: actor.userId,
          actorRole: actor.roleCode,
          action: 'employee.create',
          objectType: 'employees',
          requestPayload: input,
          failureReason: ERROR_CODES.DUPLICATE_RESOURCE,
          errorMessage: 'employeeCode already exists.',
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        });
        throw duplicateResource('employeeCode already exists.');
      }
      throw error;
    }
  }

  async list(query: ListQuery = {}) {
    return this.prisma.employee.findMany({
      where: {
        status: query.status as CommonStatus | undefined,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const employee = await this.prisma.employee.findUnique({ where: { id } });
    if (!employee) throw notFound('Employee');
    return employee;
  }

  async update(id: string, input: UpdateEmployeeInput, actor: Actor) {
    const before = await this.get(id);
    const data = this.validateUpdate(input);
    try {
      const after = await this.prisma.employee.update({ where: { id }, data });
      await this.audit.success({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'employee.update',
        objectType: 'employees',
        objectId: id,
        beforeData: before,
        afterData: after,
        changedFields: changedFields(before as never, after as never, Object.keys(data)),
        requestPayload: input,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
      return after;
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('employeeCode already exists.');
      throw error;
    }
  }

  async disable(id: string, actor: Actor) {
    const before = await this.get(id);
    if (before.status === CommonStatus.disabled) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Employee is already disabled.');
    }
    const after = await this.prisma.employee.update({
      where: { id },
      data: { status: CommonStatus.disabled },
    });
    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'employee.disable',
      objectType: 'employees',
      objectId: id,
      beforeData: before,
      afterData: after,
      changedFields: ['status'],
      requestPayload: { id },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return after;
  }

  private validateCreate(input: CreateEmployeeInput) {
    return {
      employeeCode: requireNonBlank(input.employeeCode, 'employeeCode'),
      name: requireNonBlank(input.name, 'name'),
      email: optionalNonBlank(input.email, 'email'),
      phone: optionalNonBlank(input.phone, 'phone'),
      hiredAt: parseOptionalDate(input.hiredAt, 'hiredAt'),
      leftAt: parseOptionalDate(input.leftAt, 'leftAt'),
      status: input.status ?? CommonStatus.active,
    };
  }

  private validateUpdate(input: UpdateEmployeeInput) {
    const data: Record<string, unknown> = {};
    if (input.employeeCode !== undefined) data.employeeCode = requireNonBlank(input.employeeCode, 'employeeCode');
    if (input.name !== undefined) data.name = requireNonBlank(input.name, 'name');
    if (input.email !== undefined) data.email = optionalNonBlank(input.email, 'email') ?? null;
    if (input.phone !== undefined) data.phone = optionalNonBlank(input.phone, 'phone') ?? null;
    if (input.hiredAt !== undefined) data.hiredAt = parseOptionalDate(input.hiredAt, 'hiredAt') ?? null;
    if (input.leftAt !== undefined) data.leftAt = parseOptionalDate(input.leftAt, 'leftAt') ?? null;
    if (input.status !== undefined) data.status = input.status;
    return data;
  }
}
