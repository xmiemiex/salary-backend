import { Injectable } from '@nestjs/common';
import {
  CommonStatus,
  Prisma,
  Provider,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskStatus,
  SyncTaskType,
} from '@prisma/client';
import { ERROR_CODES, PermissionCode } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { CredentialReaderService } from '../api-credentials/credential-reader.service';
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';
import { SyncAdapterResolver } from './sync-adapter-resolver';

type SyncTaskWithAccount = {
  id: string;
  sourceType: SyncTaskSourceType;
  taskType: SyncTaskType;
  platform: SyncTaskPlatform;
  affiliateAccountId: string | null;
  provider: Provider | null;
  settlementMonth: Date;
  status: SyncTaskStatus;
  successCount: number;
  failedCount: number;
  message: string | null;
  errorMessage: string | null;
  requestedBy: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  requestPayload: Prisma.JsonValue | null;
  resultPayload: Prisma.JsonValue | null;
  triggerType: string;
  attemptCount: number;
  nextAttemptAt: Date | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastAttemptAt: Date | null;
  lastErrorCategory: string | null;
  affiliateAccount: {
    id: string;
    platform: string;
    accountCode: string;
    accountName: string | null;
  } | null;
};

type ActiveCredential = {
  id: string;
  maskedPayload: Prisma.JsonValue | null;
};

type ExecutionPrisma = {
  syncTask: {
    findUnique(args: unknown): Promise<SyncTaskWithAccount | null>;
    update(args: unknown): Promise<SyncTaskWithAccount>;
  };
  affiliateAccountCredential: {
    findUnique(args: unknown): Promise<(ActiveCredential & { status: CommonStatus }) | null>;
  };
  cardProviderCredential: {
    findUnique(args: unknown): Promise<(ActiveCredential & { status: CommonStatus }) | null>;
  };
};

@Injectable()
export class SyncTaskExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
    private readonly adapters: SyncAdapterResolver,
    private readonly credentialReader: CredentialReaderService,
  ) {}

  async execute(taskId: string, actor: Actor) {
    const action = 'sync_task.execute';
    let task: SyncTaskWithAccount | null = null;
    try {
      task = await this.db().syncTask.findUnique({
        where: { id: taskId },
        include: {
          affiliateAccount: {
            select: { id: true, platform: true, accountCode: true, accountName: true },
          },
        },
      });
      if (!task) throw new AppError(ERROR_CODES.NOT_FOUND, 'Sync task not found.');

      this.assertPermission(task, actor);
      this.assertExecutableStatus(task);
      await this.monthLock.assertWritable(
        {
          settlementMonth: task.settlementMonth,
          action,
          objectType: 'sync_tasks',
          objectId: task.id,
          requestPayload: auditRequestPayload(task),
        },
        actor,
      );

      await this.assertHasActiveCredential(task);
      const credential = await this.getCredentialPayload(task);
      const adapter = this.adapters.resolve({
        sourceType: task.sourceType,
        platform: task.sourceType === SyncTaskSourceType.affiliate_income ? task.affiliateAccount?.platform : task.platform,
        provider: task.provider,
      });

      let runningTask: SyncTaskWithAccount;
      try {
        runningTask = await this.db().syncTask.update({
        where: { id: task.id, status: task.status, leaseOwner: null },
        data: {
          status: SyncTaskStatus.running,
          startedAt: new Date(),
          finishedAt: null,
          message: null,
          errorMessage: null,
          resultPayload: Prisma.JsonNull,
        },
        include: {
          affiliateAccount: {
            select: { id: true, platform: true, accountCode: true, accountName: true },
          },
        },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          throw new AppError(ERROR_CODES.CONFLICT, 'Sync task was already claimed or changed.');
        }
        throw error;
      }

      const result = await adapter.execute({
        taskId: runningTask.id,
        sourceType: runningTask.sourceType,
        taskType: runningTask.taskType,
        platform: runningTask.platform,
        provider: runningTask.provider ?? undefined,
        settlementMonth: runningTask.settlementMonth,
        affiliateAccountId: runningTask.affiliateAccountId ?? undefined,
        affiliateAccountCode: runningTask.affiliateAccount?.accountCode ?? credential.affiliateAccountCode,
        requestedBy: runningTask.requestedBy,
        credential: {
          credentialId: credential.credentialId,
          hasCredential: true,
          maskedPayload: credential.maskedPayload,
          payload: credential.payload,
        },
      });

      const finishedTask = await this.db().syncTask.update({
        where: { id: task.id, status: SyncTaskStatus.running, leaseOwner: null },
        data: {
          status: result.status === 'completed' ? SyncTaskStatus.completed : SyncTaskStatus.failed,
          finishedAt: new Date(),
          successCount: result.successCount,
          failedCount: result.failedCount,
          message: result.message,
          errorMessage: result.errorMessage,
          resultPayload: result.resultPayload as Prisma.InputJsonObject,
          lastErrorCategory: result.errorCategory ?? null,
        },
        include: {
          affiliateAccount: {
            select: { id: true, platform: true, accountCode: true, accountName: true },
          },
        },
      });

      await this.audit.success({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action,
        objectType: 'sync_tasks',
        objectId: finishedTask.id,
        settlementMonth: finishedTask.settlementMonth,
        afterData: auditAfterData(finishedTask),
        changedFields: ['status', 'startedAt', 'finishedAt', 'successCount', 'failedCount', 'message', 'errorMessage', 'lastErrorCategory'],
        requestPayload: auditRequestPayload(finishedTask),
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });

      return toDto(finishedTask);
    } catch (error) {
      if (!(error instanceof AppError) || error.code === ERROR_CODES.MONTH_LOCKED) throw error;

      await this.audit.failure({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action,
        objectType: 'sync_tasks',
        objectId: task?.id ?? taskId,
        settlementMonth: task?.settlementMonth,
        requestPayload: task ? auditRequestPayload(task) : { taskId },
        failureReason: error.code,
        errorMessage: error.message,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
      throw error;
    }
  }

  private assertPermission(task: SyncTaskWithAccount, actor: Actor) {
    const required: PermissionCode =
      task.sourceType === SyncTaskSourceType.affiliate_income ? 'income.import' : 'manual_card_spend.manage';
    if (!actor.permissions.includes(required)) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'Permission denied.', {
        requiredPermissions: [required],
        missingPermissions: [required],
      });
    }
  }

  private assertExecutableStatus(task: SyncTaskWithAccount) {
    if (task.status === SyncTaskStatus.running) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Sync task is already running.');
    }
    if (task.status === SyncTaskStatus.completed) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Completed sync task cannot be executed again.');
    }
    if (task.status === SyncTaskStatus.cancelled) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Cancelled sync task cannot be executed.');
    }
  }

  private async assertHasActiveCredential(task: SyncTaskWithAccount): Promise<void> {
    if (task.sourceType === SyncTaskSourceType.affiliate_income) {
      if (!task.affiliateAccountId) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'affiliateAccountId is required for affiliate_income sync task.');
      }

      const credential = await this.db().affiliateAccountCredential.findUnique({
        where: { affiliateAccountId: task.affiliateAccountId },
        select: { id: true, maskedPayload: true, status: true },
      });
      if (!credential || credential.status !== CommonStatus.active) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Active affiliate account credential is required before executing sync task.');
      }
      return;
    }

    if (!task.provider) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'provider is required for card_spend sync task.');
    }

    const credential = await this.db().cardProviderCredential.findUnique({
      where: { provider: task.provider },
      select: { id: true, maskedPayload: true, status: true },
    });
    if (!credential || credential.status !== CommonStatus.active) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Active card provider credential is required before executing sync task.');
    }
  }

  private async getCredentialPayload(task: SyncTaskWithAccount) {
    if (task.sourceType === SyncTaskSourceType.affiliate_income) {
      return this.credentialReader.getAffiliateAccountCredentialPayload(task.affiliateAccountId as string);
    }
    return this.credentialReader.getCardProviderCredentialPayload(task.provider as Provider);
  }

  private db(): ExecutionPrisma {
    return this.prisma as unknown as ExecutionPrisma;
  }
}

function auditRequestPayload(task: SyncTaskWithAccount) {
  return {
    taskId: task.id,
    taskType: task.taskType,
    platform: task.sourceType === SyncTaskSourceType.affiliate_income ? task.affiliateAccount?.platform : task.platform,
    provider: task.provider,
    settlementMonth: task.settlementMonth.toISOString().slice(0, 10),
  };
}

function auditAfterData(task: SyncTaskWithAccount) {
  return {
    status: task.status,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    successCount: task.successCount,
    failedCount: task.failedCount,
    message: task.message,
    errorMessage: task.errorMessage,
  };
}

function toDto(task: SyncTaskWithAccount) {
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
    attemptCount: task.attemptCount,
    nextAttemptAt: task.nextAttemptAt,
    lastAttemptAt: task.lastAttemptAt,
    lastErrorCategory: task.lastErrorCategory,
    executing: task.status === SyncTaskStatus.running && !!task.leaseExpiresAt,
  };
}
