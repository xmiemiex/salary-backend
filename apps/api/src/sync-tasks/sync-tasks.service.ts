import { Injectable } from '@nestjs/common';
import {
  Prisma,
  Provider,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskStatus,
  SyncTaskType,
} from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { optionalNonBlank, requireNonBlank } from '../base-data/base-data.utils';
import { AppError } from '../common/app-error';
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';

const AFFILIATE_PLATFORMS = [SyncTaskPlatform.everflow, SyncTaskPlatform.cake] as const;
const CARD_PROVIDERS = [Provider.airwallex, Provider.photonpay] as const;
const AFFILIATE_NOT_IMPLEMENTED_MESSAGE = '真实联盟收入同步接口未接入，本任务只记录请求，不拉取第三方数据。';
const CARD_NOT_IMPLEMENTED_MESSAGE = '真实虚拟卡同步接口未接入，本任务只记录请求，不拉取第三方数据。';

export type CreateAffiliateIncomeSyncTaskInput = {
  settlementMonth: string | Date;
  affiliateAccountId: string;
};

export type CreateCardSpendSyncTaskInput = {
  settlementMonth: string | Date;
};

export type SyncTasksQuery = {
  settlementMonth?: string;
  taskType?: string;
  platform?: string;
  affiliateAccountId?: string;
  status?: string;
  page?: string;
  pageSize?: string;
};

@Injectable()
export class SyncTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
  ) {}

  async list(query: SyncTasksQuery = {}) {
    const page = parsePositiveInt(query.page, 'page', 1);
    const pageSize = Math.min(parsePositiveInt(query.pageSize, 'pageSize', 20), 100);
    const where: Prisma.SyncTaskWhereInput = {
      settlementMonth: query.settlementMonth ? parseSettlementMonth(query.settlementMonth, 'settlementMonth') : undefined,
      taskType: query.taskType ? assertEnumValue(SyncTaskType, query.taskType, 'taskType') : undefined,
      platform: query.platform ? assertEnumValue(SyncTaskPlatform, query.platform, 'platform') : undefined,
      affiliateAccountId: optionalNonBlank(query.affiliateAccountId, 'affiliateAccountId'),
      status: query.status ? assertEnumValue(SyncTaskStatus, query.status, 'status') : undefined,
    };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.syncTask.count({ where }),
      this.prisma.syncTask.findMany({
        where,
        include: {
          affiliateAccount: {
            select: { id: true, platform: true, accountCode: true, accountName: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: items.map(toDto),
      total,
      page,
      pageSize,
    };
  }

  async createAffiliateIncome(input: CreateAffiliateIncomeSyncTaskInput, actor: Actor) {
    const action = 'sync_task.create.affiliate_income';
    try {
      const settlementMonth = parseSettlementMonth(input.settlementMonth, 'settlementMonth');
      const affiliateAccountId = requireNonBlank(input.affiliateAccountId, 'affiliateAccountId');
      const affiliateAccount = await this.prisma.affiliateAccount.findUnique({
        where: { id: affiliateAccountId },
        select: { id: true, platform: true, accountCode: true, accountName: true },
      });
      if (!affiliateAccount) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Affiliate account not found.');
      }

      const platform = normalizeAffiliatePlatform(affiliateAccount.platform);
      await this.assertWritable(settlementMonth, action, undefined, input, actor);

      const task = await this.prisma.syncTask.create({
        data: {
          sourceType: SyncTaskSourceType.affiliate_income,
          taskType: SyncTaskType.affiliate_income,
          platform,
          affiliateAccountId,
          settlementMonth,
          status: SyncTaskStatus.not_implemented,
          message: AFFILIATE_NOT_IMPLEMENTED_MESSAGE,
          requestedBy: actor.userId,
          requestPayload: input as Prisma.InputJsonObject,
        },
        include: { affiliateAccount: { select: { id: true, platform: true, accountCode: true, accountName: true } } },
      });

      await this.audit.success(auditInput(actor, action, task.id, settlementMonth, task, input));
      return toDto(task);
    } catch (error) {
      await this.auditFailureUnlessMonthLocked(error, actor, action, input);
      throw error;
    }
  }

  async createCardSpend(providerInput: string, input: CreateCardSpendSyncTaskInput, actor: Actor) {
    let action = 'sync_task.create.card_spend';
    try {
      const provider = normalizeCardProvider(providerInput);
      action = `sync_task.create.${provider}_card`;
      const settlementMonth = parseSettlementMonth(input.settlementMonth, 'settlementMonth');
      await this.assertWritable(settlementMonth, action, undefined, { provider, ...input }, actor);

      const taskType = provider === Provider.airwallex ? SyncTaskType.airwallex_card : SyncTaskType.photonpay_card;
      const platform = provider === Provider.airwallex ? SyncTaskPlatform.airwallex : SyncTaskPlatform.photonpay;
      const task = await this.prisma.syncTask.create({
        data: {
          sourceType: SyncTaskSourceType.card_spend,
          taskType,
          platform,
          provider,
          settlementMonth,
          status: SyncTaskStatus.not_implemented,
          message: CARD_NOT_IMPLEMENTED_MESSAGE,
          requestedBy: actor.userId,
          requestPayload: { provider, ...input } as Prisma.InputJsonObject,
        },
      });

      await this.audit.success(auditInput(actor, action, task.id, settlementMonth, task, { provider, ...input }));
      return toDto(task);
    } catch (error) {
      await this.auditFailureUnlessMonthLocked(error, actor, action, { provider: providerInput, ...input });
      throw error;
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
      { settlementMonth, action, objectType: 'sync_tasks', objectId, requestPayload },
      actor,
    );
  }

  private async auditFailureUnlessMonthLocked(
    error: unknown,
    actor: Actor,
    action: string,
    requestPayload: unknown,
  ) {
    if (error instanceof AppError && error.code === ERROR_CODES.MONTH_LOCKED) return;
    if (!(error instanceof AppError)) return;

    await this.audit.failure({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action,
      objectType: 'sync_tasks',
      requestPayload,
      failureReason: error.code,
      errorMessage: error.message,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }
}

function parseSettlementMonth(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a valid date.`);
    }
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1, 0, 0, 0, 0));
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is required.`);
  }

  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value.trim());
  if (!match) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must use YYYY-MM or YYYY-MM-DD format.`);
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must use YYYY-MM or YYYY-MM-DD format.`);
  }
  return new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
}

function normalizeAffiliatePlatform(platform: string): (typeof AFFILIATE_PLATFORMS)[number] {
  const normalized = platform.trim().toLowerCase();
  if (AFFILIATE_PLATFORMS.includes(normalized as (typeof AFFILIATE_PLATFORMS)[number])) {
    return normalized as (typeof AFFILIATE_PLATFORMS)[number];
  }
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'affiliateAccount.platform must be everflow or cake.');
}

function normalizeCardProvider(provider: string): (typeof CARD_PROVIDERS)[number] {
  const normalized = provider.trim().toLowerCase();
  if (CARD_PROVIDERS.includes(normalized as (typeof CARD_PROVIDERS)[number])) {
    return normalized as (typeof CARD_PROVIDERS)[number];
  }
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'provider must be airwallex or photonpay.');
}

function assertEnumValue<T extends Record<string, string>>(enumObject: T, value: string, field: string): T[keyof T] {
  if (Object.values(enumObject).includes(value)) return value as T[keyof T];
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is invalid.`);
}

function parsePositiveInt(value: string | undefined, field: string, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a positive integer.`);
  }
  return parsed;
}

function auditInput(
  actor: Actor,
  action: string,
  objectId: string,
  settlementMonth: Date,
  afterData: unknown,
  requestPayload: unknown,
) {
  return {
    actorUserId: actor.userId,
    actorRole: actor.roleCode,
    action,
    objectType: 'sync_tasks',
    objectId,
    settlementMonth,
    afterData,
    changedFields: ['sourceType', 'taskType', 'platform', 'status'],
    requestPayload,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  };
}

function toDto(task: {
  id: string;
  sourceType: SyncTaskSourceType;
  taskType: SyncTaskType;
  platform: SyncTaskPlatform;
  affiliateAccountId?: string | null;
  provider?: Provider | null;
  settlementMonth: Date;
  status: SyncTaskStatus;
  successCount: number;
  failedCount: number;
  message?: string | null;
  errorMessage?: string | null;
  requestedBy?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  requestPayload?: Prisma.JsonValue | null;
  resultPayload?: Prisma.JsonValue | null;
  triggerType?: string;
  attemptCount?: number;
  nextAttemptAt?: Date | null;
  leaseExpiresAt?: Date | null;
  lastAttemptAt?: Date | null;
  lastErrorCategory?: string | null;
  affiliateAccount?: {
    id: string;
    platform: string;
    accountCode: string;
    accountName?: string | null;
  } | null;
}) {
  return {
    id: task.id,
    taskId: task.id,
    sourceType: task.sourceType,
    taskType: task.taskType,
    platform: task.platform,
    affiliateAccountId: task.affiliateAccountId,
    affiliateAccount: task.affiliateAccount,
    provider: task.provider,
    settlementMonth: task.settlementMonth.toISOString().slice(0, 10),
    status: task.status,
    successCount: task.successCount,
    failedCount: task.failedCount,
    message: task.message,
    errorMessage: task.errorMessage,
    requestedBy: task.requestedBy,
    createdBy: task.requestedBy,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    requestPayload: task.requestPayload,
    resultPayload: task.resultPayload,
    triggerType: task.triggerType,
    attemptCount: task.attemptCount ?? 0,
    nextAttemptAt: task.nextAttemptAt,
    lastAttemptAt: task.lastAttemptAt,
    lastErrorCategory: task.lastErrorCategory,
    executing: task.status === SyncTaskStatus.running && !!task.leaseExpiresAt,
  };
}
