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
  requireNonBlank,
} from '../base-data/base-data.utils';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';

export type CreateAffiliateAccountInput = {
  platform: string;
  accountCode: string;
  accountName?: string;
  defaultEmployeeId?: string;
  status?: CommonStatus;
};

export type UpdateAffiliateAccountInput = Partial<CreateAffiliateAccountInput>;

@Injectable()
export class AffiliateAccountsService {
  readonly requiredPermission = 'api_config.manage';

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateAffiliateAccountInput, actor: Actor) {
    const data = this.validateCreate(input);
    try {
      const account = await this.prisma.affiliateAccount.create({ data });
      await this.audit.success(this.auditInput(actor, 'affiliate_account.create', account.id, undefined, account, Object.keys(data), input));
      return account;
    } catch (error) {
      if (isDuplicateError(error)) {
        await this.audit.failure({
          actorUserId: actor.userId,
          actorRole: actor.roleCode,
          action: 'affiliate_account.create',
          objectType: 'affiliate_accounts',
          requestPayload: input,
          failureReason: ERROR_CODES.DUPLICATE_RESOURCE,
          errorMessage: 'platform + accountCode already exists.',
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        });
        throw duplicateResource('platform + accountCode already exists.');
      }
      throw error;
    }
  }

  async list(query: ListQuery = {}) {
    return this.prisma.affiliateAccount.findMany({
      where: { status: query.status as CommonStatus | undefined },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const account = await this.prisma.affiliateAccount.findUnique({ where: { id } });
    if (!account) throw notFound('Affiliate account');
    return account;
  }

  async update(id: string, input: UpdateAffiliateAccountInput, actor: Actor) {
    const before = await this.get(id);
    const data = this.validateUpdate(input);
    try {
      const after = await this.prisma.affiliateAccount.update({ where: { id }, data });
      await this.audit.success(
        this.auditInput(
          actor,
          'affiliate_account.update',
          id,
          before,
          after,
          changedFields(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, Object.keys(data)),
          input,
        ),
      );
      return after;
    } catch (error) {
      if (isDuplicateError(error)) throw duplicateResource('platform + accountCode already exists.');
      throw error;
    }
  }

  async disable(id: string, actor: Actor) {
    const before = await this.get(id);
    if (before.status === CommonStatus.disabled) throw new AppError(ERROR_CODES.CONFLICT, 'Affiliate account is already disabled.');
    const after = await this.prisma.affiliateAccount.update({ where: { id }, data: { status: CommonStatus.disabled } });
    await this.audit.success(this.auditInput(actor, 'affiliate_account.disable', id, before, after, ['status'], { id }));
    return after;
  }

  private validateCreate(input: CreateAffiliateAccountInput) {
    return {
      platform: requireNonBlank(input.platform, 'platform'),
      accountCode: requireNonBlank(input.accountCode, 'accountCode'),
      accountName: optionalNonBlank(input.accountName, 'accountName'),
      defaultEmployeeId: optionalNonBlank(input.defaultEmployeeId, 'defaultEmployeeId'),
      status: input.status ?? CommonStatus.active,
    };
  }

  private validateUpdate(input: UpdateAffiliateAccountInput) {
    const data: Record<string, unknown> = {};
    if (input.platform !== undefined) data.platform = requireNonBlank(input.platform, 'platform');
    if (input.accountCode !== undefined) data.accountCode = requireNonBlank(input.accountCode, 'accountCode');
    if (input.accountName !== undefined) data.accountName = optionalNonBlank(input.accountName, 'accountName') ?? null;
    if (input.defaultEmployeeId !== undefined) data.defaultEmployeeId = optionalNonBlank(input.defaultEmployeeId, 'defaultEmployeeId') ?? null;
    if (input.status !== undefined) data.status = input.status;
    return data;
  }

  private auditInput(
    actor: Actor,
    action: string,
    objectId: string,
    beforeData: unknown,
    afterData: unknown,
    fields: string[],
    requestPayload: unknown,
  ) {
    return {
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action,
      objectType: 'affiliate_accounts',
      objectId,
      beforeData,
      afterData,
      changedFields: fields,
      requestPayload,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    };
  }
}
