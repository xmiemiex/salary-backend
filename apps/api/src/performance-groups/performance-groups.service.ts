import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma, SalaryMode } from '@prisma/client';
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
  requireNonBlank,
} from '../base-data/base-data.utils';
import { assertOptionalStatus, auditInput } from '../base-data/manual-entry.utils';
import { AppError } from '../common/app-error';
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';

const ONE = new Prisma.Decimal('1');
const GROUP_STATUSES = [CommonStatus.active, CommonStatus.disabled] as const;

export type PerformanceGroupMemberInput = {
  employeeId: string;
  allocationRatio: string;
};

export type CreatePerformanceGroupInput = {
  settlementMonth: string | Date;
  name: string;
  salaryMode?: SalaryMode;
  members: PerformanceGroupMemberInput[];
  status?: CommonStatus;
};

export type UpdatePerformanceGroupInput = Partial<Omit<CreatePerformanceGroupInput, 'members'>> & {
  members?: PerformanceGroupMemberInput[];
};

@Injectable()
export class PerformanceGroupsService {
  readonly requiredPermission = 'performance_group.manage';

  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreatePerformanceGroupInput, actor: Actor) {
    const data = this.validateCreate(input);
    await this.assertWritable(data.group.settlementMonth, 'performance_group.create', undefined, input, actor);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertNoDuplicateEmployees(data.group.settlementMonth, data.members.map((member) => member.employeeId), tx);
        const group = await tx.monthlyPerformanceGroup.create({
          data: { ...data.group, createdBy: actor.userId },
        });
        if (data.members.length > 0) {
          await tx.monthlyPerformanceGroupMember.createMany({
            data: data.members.map((member) => ({
              settlementMonth: data.group.settlementMonth,
              groupId: group.id,
              employeeId: member.employeeId,
              allocationRatio: member.allocationRatio,
            })),
          });
        }
        const after = { group, members: data.members };
        await this.audit.success(
          auditInput({
            actor,
            action: 'performance_group.create',
            objectType: 'monthly_performance_groups',
            objectId: group.id,
            settlementMonth: group.settlementMonth,
            afterData: after,
            changedFields: ['settlementMonth', 'name', 'salaryMode', 'status', 'members'],
            requestPayload: input,
          }),
          tx,
        );
        return after;
      });
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('performance group name or employee membership already exists for this month.');
      throw error;
    }
  }

  async list(query: ListQuery = {}) {
    return this.prisma.monthlyPerformanceGroup.findMany({
      where: {
        status: query.status as CommonStatus | undefined,
        settlementMonth: query.settlementMonth ? parseMonthStart(query.settlementMonth, 'settlementMonth') : undefined,
      },
      include: { members: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const group = await this.prisma.monthlyPerformanceGroup.findUnique({
      where: { id },
      include: { members: true },
    });
    if (!group) throw notFound('Performance group');
    return group;
  }

  async update(id: string, input: UpdatePerformanceGroupInput, actor: Actor) {
    const before = await this.get(id);
    const data = this.validateUpdate(input);
    const nextSettlementMonth = (data.group.settlementMonth as Date | undefined) ?? before.settlementMonth;
    await this.assertWritable(before.settlementMonth, 'performance_group.update', id, input, actor);
    if (nextSettlementMonth.getTime() !== before.settlementMonth.getTime()) {
      await this.assertWritable(nextSettlementMonth, 'performance_group.update', id, input, actor);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (data.members) {
          await this.assertNoDuplicateEmployees(
            nextSettlementMonth,
            data.members.map((member) => member.employeeId),
            tx,
            id,
          );
        }

        const group = await tx.monthlyPerformanceGroup.update({
          where: { id },
          data: data.group,
        });

        let members = before.members.map((member) => ({
          employeeId: member.employeeId,
          allocationRatio: member.allocationRatio,
        }));
        if (data.members) {
          await tx.monthlyPerformanceGroupMember.deleteMany({ where: { groupId: id } });
          await tx.monthlyPerformanceGroupMember.createMany({
            data: data.members.map((member) => ({
              settlementMonth: group.settlementMonth,
              groupId: id,
              employeeId: member.employeeId,
              allocationRatio: member.allocationRatio,
            })),
          });
          members = data.members;
        }

        const after = { group, members };
        await this.audit.success(
          auditInput({
            actor,
            action: 'performance_group.update',
            objectType: 'monthly_performance_groups',
            objectId: id,
            settlementMonth: group.settlementMonth,
            beforeData: before,
            afterData: after,
            changedFields: [...changedFields(before as never, group as never, Object.keys(data.group)), ...(data.members ? ['members'] : [])],
            requestPayload: input,
          }),
          tx,
        );
        return after;
      });
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('performance group name or employee membership already exists for this month.');
      throw error;
    }
  }

  async disable(id: string, actor: Actor) {
    const before = await this.get(id);
    await this.assertWritable(before.settlementMonth, 'performance_group.disable', id, { id }, actor);
    const group = await this.prisma.monthlyPerformanceGroup.update({
      where: { id },
      data: { status: CommonStatus.disabled },
    });
    const after = { group, members: before.members };
    await this.audit.success(
      auditInput({
        actor,
        action: 'performance_group.disable',
        objectType: 'monthly_performance_groups',
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

  private validateCreate(input: CreatePerformanceGroupInput) {
    const settlementMonth = parseMonthStart(input.settlementMonth, 'settlementMonth');
    const members = this.validateMembers(input.members);
    return {
      group: {
        settlementMonth,
        name: requireNonBlank(input.name, 'name'),
        salaryMode: SalaryMode.group,
        status: assertOptionalStatus(input.status, GROUP_STATUSES) ?? CommonStatus.active,
      },
      members,
    };
  }

  private validateUpdate(input: UpdatePerformanceGroupInput) {
    const group: Record<string, unknown> = {};
    if (input.settlementMonth !== undefined && input.members === undefined) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'settlementMonth change requires members replacement.',
      );
    }
    if (input.settlementMonth !== undefined) group.settlementMonth = parseMonthStart(input.settlementMonth, 'settlementMonth');
    if (input.name !== undefined) group.name = requireNonBlank(input.name, 'name');
    if (input.salaryMode !== undefined && input.salaryMode !== SalaryMode.group) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'salaryMode must be group.');
    }
    if (input.salaryMode !== undefined) group.salaryMode = SalaryMode.group;
    if (input.status !== undefined) group.status = assertOptionalStatus(input.status, GROUP_STATUSES);
    return {
      group,
      members: input.members === undefined ? undefined : this.validateMembers(input.members),
    };
  }

  private validateMembers(input: PerformanceGroupMemberInput[] | undefined) {
    if (!Array.isArray(input) || input.length === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'members must not be empty.');
    }
    const seen = new Set<string>();
    let total = new Prisma.Decimal('0');
    const members = input.map((member) => {
      const employeeId = requireNonBlank(member.employeeId, 'employeeId');
      if (seen.has(employeeId)) {
        throw new AppError(ERROR_CODES.CONFLICT, 'employeeId is duplicated in members.');
      }
      seen.add(employeeId);
      const allocationRatio = parseDecimalString(member.allocationRatio, 'allocationRatio', { gtZero: true });
      total = total.plus(allocationRatio);
      return { employeeId, allocationRatio };
    });
    if (!total.equals(ONE)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'allocationRatio sum must equal 1.', {
        allocationRatioSum: total.toString(),
      });
    }
    return members;
  }

  private async assertNoDuplicateEmployees(
    settlementMonth: Date,
    employeeIds: string[],
    prisma: PrismaService | Prisma.TransactionClient,
    excludeGroupId?: string,
  ) {
    const existing = await prisma.monthlyPerformanceGroupMember.findFirst({
      where: {
        settlementMonth,
        employeeId: { in: employeeIds },
        groupId: excludeGroupId ? { not: excludeGroupId } : undefined,
      },
    });
    if (existing) {
      throw new AppError(ERROR_CODES.CONFLICT, 'employee already belongs to a performance group for this month.', {
        employeeId: existing.employeeId,
        settlementMonth: settlementMonth.toISOString().slice(0, 10),
      });
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
      { settlementMonth, action, objectType: 'monthly_performance_groups', objectId, requestPayload },
      actor,
    );
  }
}
