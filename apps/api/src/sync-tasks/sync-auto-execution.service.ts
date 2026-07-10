import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  CommonStatus,
  Prisma,
  Provider,
  SettlementStatus,
  SyncExecutionErrorCategory,
  SyncTaskSourceType,
  SyncTaskStatus,
  SyncTaskTriggerType,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CredentialReaderService } from '../api-credentials/credential-reader.service';
import { PrismaService } from '../prisma/prisma.service';
import { SyncAdapterResolver } from './sync-adapter-resolver';
import { readSyncAutoExecutionConfig, retryDelaySeconds } from './sync-auto-execution-config';

type ClaimedTask = {
  id: string;
  sourceType: SyncTaskSourceType;
  platform: string;
  provider: Provider | null;
  settlementMonth: Date;
  attemptCount: number;
  recovered: boolean;
};

const RETRYABLE = new Set<SyncExecutionErrorCategory>([
  SyncExecutionErrorCategory.NETWORK_ERROR,
  SyncExecutionErrorCategory.TIMEOUT,
  SyncExecutionErrorCategory.RATE_LIMITED,
  SyncExecutionErrorCategory.PROVIDER_5XX,
  SyncExecutionErrorCategory.TEMPORARY_DATABASE_ERROR,
]);

@Injectable()
export class SyncAutoExecutionService {
  private readonly logger = new Logger(SyncAutoExecutionService.name);
  private readonly config = readSyncAutoExecutionConfig();
  private readonly instanceId = randomUUID();
  private lastPollAt: Date | null = null;
  private lastClaimAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly adapters: SyncAdapterResolver,
    private readonly credentialReader: CredentialReaderService,
  ) {}

  async poll(now = new Date()) {
    this.lastPollAt = now;
    if (!this.config.enabled) return { claimedCount: 0, disabled: true as const };
    const tasks = await this.claim(now);
    if (tasks.length) this.lastClaimAt = now;
    await Promise.all(tasks.map((task) => this.executeClaim(task).catch(() => undefined)));
    return { claimedCount: tasks.length, disabled: false as const };
  }

  async status(now = new Date()) {
    const [counts] = await this.prisma.$queryRaw<Array<{ active: bigint; pending: bigint; waiting: bigint; failed: bigint }>>`
      SELECT
        COUNT(*) FILTER (WHERE t.status = 'running' AND t.lease_expires_at > ${now}) AS active,
        COUNT(*) FILTER (WHERE t.trigger_type = 'scheduled' AND t.planning_key IS NOT NULL AND t.status = 'pending'
          AND t.attempt_count < ${this.config.maxAttempts}
          AND NOT EXISTS (SELECT 1 FROM monthly_settlements ms WHERE ms.settlement_month = t.settlement_month AND ms.status = 'locked')
          AND ((t.source_type = 'affiliate_income' AND aa.status = 'active' AND lower(aa.platform) IN ('everflow', 'cake') AND ac.id IS NOT NULL)
            OR (t.source_type = 'card_spend' AND t.provider IN ('airwallex', 'photonpay') AND cc.id IS NOT NULL))) AS pending,
        COUNT(*) FILTER (WHERE t.trigger_type = 'scheduled' AND t.status = 'retry_wait' AND t.next_attempt_at > ${now}) AS waiting,
        COUNT(*) FILTER (WHERE t.trigger_type = 'scheduled' AND t.status = 'failed') AS failed
      FROM sync_tasks t
      LEFT JOIN affiliate_accounts aa ON aa.id = t.affiliate_account_id
      LEFT JOIN affiliate_account_credentials ac ON ac.affiliate_account_id = aa.id AND ac.status = 'active'
      LEFT JOIN card_provider_credentials cc ON cc.provider = t.provider AND cc.status = 'active'
    `;
    return {
      enabled: this.config.enabled,
      pollSeconds: this.config.pollSeconds,
      batchSize: this.config.batchSize,
      maxAttempts: this.config.maxAttempts,
      activeLeaseCount: Number(counts?.active ?? 0),
      pendingEligibleCount: Number(counts?.pending ?? 0),
      retryWaitingCount: Number(counts?.waiting ?? 0),
      permanentlyFailedCount: Number(counts?.failed ?? 0),
      lastPollAt: this.lastPollAt,
      lastClaimAt: this.lastClaimAt,
    };
  }

  private async claim(now: Date): Promise<ClaimedTask[]> {
    const leaseExpiresAt = new Date(now.getTime() + this.config.leaseSeconds * 1000);
    return this.prisma.$transaction(async (tx) => {
      const tasks = await tx.$queryRaw<ClaimedTask[]>`
        WITH candidates AS (
          SELECT t.id, (t.status = 'running') AS recovered
          FROM sync_tasks t
          LEFT JOIN affiliate_accounts aa ON aa.id = t.affiliate_account_id
          LEFT JOIN affiliate_account_credentials ac ON ac.affiliate_account_id = aa.id AND ac.status = 'active'
          LEFT JOIN card_provider_credentials cc ON cc.provider = t.provider AND cc.status = 'active'
          WHERE t.trigger_type = 'scheduled'
            AND t.planning_key IS NOT NULL
            AND t.attempt_count < ${this.config.maxAttempts}
            AND (
              (t.status = 'pending') OR
              (t.status = 'retry_wait' AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= ${now})) OR
              (t.status = 'running' AND t.lease_expires_at <= ${now})
            )
            AND NOT EXISTS (
              SELECT 1 FROM monthly_settlements ms
              WHERE ms.settlement_month = t.settlement_month AND ms.status = 'locked'
            )
            AND (
              (t.source_type = 'affiliate_income' AND aa.status = 'active' AND lower(aa.platform) IN ('everflow', 'cake') AND ac.id IS NOT NULL) OR
              (t.source_type = 'card_spend' AND t.provider IN ('airwallex', 'photonpay') AND cc.id IS NOT NULL)
            )
          ORDER BY t.created_at, t.id
          FOR UPDATE OF t SKIP LOCKED
          LIMIT ${this.config.batchSize}
        ), claimed AS (
          UPDATE sync_tasks t
          SET status = 'running', lease_owner = ${this.instanceId}, lease_expires_at = ${leaseExpiresAt},
              attempt_count = t.attempt_count + 1, last_attempt_at = ${now}, next_attempt_at = NULL,
              started_at = COALESCE(t.started_at, ${now}), finished_at = NULL, updated_at = ${now}
          FROM candidates c WHERE t.id = c.id
          RETURNING t.id, t.source_type, t.platform, t.provider, t.settlement_month, t.attempt_count, c.recovered
        )
        SELECT id, source_type AS "sourceType", platform::text AS platform, provider,
               settlement_month AS "settlementMonth", attempt_count AS "attemptCount", recovered
        FROM claimed
      `;
      for (const task of tasks) {
        await this.audit.success({
          action: task.recovered ? 'sync_task.auto.lease_recovered' : 'sync_task.auto.claimed',
          objectType: 'sync_tasks', objectId: task.id, settlementMonth: task.settlementMonth,
          afterData: this.auditSummary(task), changedFields: ['status', 'attemptCount', 'lastAttemptAt'],
          requestPayload: { triggerType: SyncTaskTriggerType.scheduled },
        }, tx);
      }
      return tasks;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  private async executeClaim(claim: ClaimedTask) {
    try {
      const task = await this.prisma.syncTask.findUnique({
        where: { id: claim.id },
        include: { affiliateAccount: { select: { id: true, platform: true, status: true } } },
      });
      if (!task || task.status !== SyncTaskStatus.running || task.leaseOwner !== this.instanceId) return;

      const blocker = await this.preExecutionBlocker(task);
      if (blocker) {
        await this.finishFailure(task.id, claim, blocker, blockerMessage(blocker));
        return;
      }

      const credential = task.sourceType === SyncTaskSourceType.affiliate_income
        ? await this.credentialReader.getAffiliateAccountCredentialPayload(task.affiliateAccountId as string)
        : await this.credentialReader.getCardProviderCredentialPayload(task.provider as Provider);
      const adapter = this.adapters.resolve({
        sourceType: task.sourceType,
        platform: task.sourceType === SyncTaskSourceType.affiliate_income ? task.affiliateAccount?.platform : task.platform,
        provider: task.provider,
      });
      const result = await adapter.execute({
        taskId: task.id, sourceType: task.sourceType, taskType: task.taskType, platform: task.platform,
        provider: task.provider ?? undefined, settlementMonth: task.settlementMonth,
        affiliateAccountId: task.affiliateAccountId ?? undefined, requestedBy: null,
        credential: { credentialId: credential.credentialId, hasCredential: true, maskedPayload: credential.maskedPayload, payload: credential.payload },
      });
      if (result.status === 'completed') await this.finishSuccess(task.id, claim, result);
      else await this.finishFailure(task.id, claim, result.errorCategory ?? SyncExecutionErrorCategory.BUSINESS_REJECTED, result.errorMessage ?? 'Provider sync failed.', result);
    } catch (error) {
      const category = classifyUnexpected(error);
      await this.finishFailure(claim.id, claim, category, safeErrorMessage(error, category)).catch(() => undefined);
      this.logger.warn(`Automatic sync task ${claim.id} failed with ${category}.`);
    }
  }

  private async preExecutionBlocker(task: Awaited<ReturnType<PrismaService['syncTask']['findUnique']>> & { affiliateAccount?: { platform: string; status: CommonStatus } | null }) {
    const locked = await this.prisma.monthlySettlement.findUnique({ where: { settlementMonth: task!.settlementMonth }, select: { status: true } });
    if (locked?.status === SettlementStatus.locked) return SyncExecutionErrorCategory.MONTH_LOCKED;
    if (task!.sourceType === SyncTaskSourceType.affiliate_income) {
      if (!task!.affiliateAccount || task!.affiliateAccount.status !== CommonStatus.active) return SyncExecutionErrorCategory.BUSINESS_REJECTED;
      if (!['everflow', 'cake'].includes(task!.affiliateAccount.platform.toLowerCase())) return SyncExecutionErrorCategory.UNSUPPORTED_PLATFORM;
      const credential = await this.prisma.affiliateAccountCredential.findFirst({ where: { affiliateAccountId: task!.affiliateAccountId!, status: CommonStatus.active }, select: { id: true } });
      return credential ? null : SyncExecutionErrorCategory.CREDENTIAL_MISSING;
    }
    if (!task!.provider || ![Provider.airwallex, Provider.photonpay].includes(task!.provider)) return SyncExecutionErrorCategory.UNSUPPORTED_PROVIDER;
    const credential = await this.prisma.cardProviderCredential.findFirst({ where: { provider: task!.provider, status: CommonStatus.active }, select: { id: true } });
    return credential ? null : SyncExecutionErrorCategory.CREDENTIAL_MISSING;
  }

  private async finishSuccess(taskId: string, claim: ClaimedTask, result: { successCount: number; failedCount: number; message: string | null; resultPayload: Record<string, unknown> }) {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.syncTask.updateMany({ where: { id: taskId, status: SyncTaskStatus.running, leaseOwner: this.instanceId }, data: {
        status: SyncTaskStatus.completed, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null,
        lastErrorCategory: null, finishedAt: new Date(), successCount: result.successCount, failedCount: result.failedCount,
        message: result.message, errorMessage: null, resultPayload: { ...result.resultPayload, attemptCount: claim.attemptCount },
      } });
      if (!updated.count) return;
      await this.audit.success({ action: 'sync_task.auto.succeeded', objectType: 'sync_tasks', objectId: taskId,
        settlementMonth: claim.settlementMonth, afterData: this.auditSummary(claim), changedFields: ['status', 'finishedAt'],
        requestPayload: { triggerType: SyncTaskTriggerType.scheduled } }, tx);
    });
  }

  private async finishFailure(taskId: string, claim: ClaimedTask, category: SyncExecutionErrorCategory, message: string, result?: { successCount: number; failedCount: number; resultPayload: Record<string, unknown> }) {
    const retry = RETRYABLE.has(category) && claim.attemptCount < this.config.maxAttempts;
    const nextAttemptAt = retry ? new Date(Date.now() + retryDelaySeconds(this.config.retryBaseSeconds, claim.attemptCount) * 1000) : null;
    const safeMessage = redact(message);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.syncTask.updateMany({ where: { id: taskId, status: SyncTaskStatus.running, leaseOwner: this.instanceId }, data: {
        status: retry ? SyncTaskStatus.retry_wait : SyncTaskStatus.failed,
        leaseOwner: null, leaseExpiresAt: null, nextAttemptAt, lastErrorCategory: category,
        finishedAt: retry ? null : new Date(), successCount: result?.successCount ?? 0, failedCount: result?.failedCount ?? 1,
        message: retry ? 'Automatic sync will retry after a temporary failure.' : 'Automatic sync stopped after a non-retryable or final failure.',
        errorMessage: safeMessage,
        resultPayload: { ...(result?.resultPayload ?? {}), attemptCount: claim.attemptCount, errorCategory: category },
      } });
      if (!updated.count) return;
      const action = retry ? 'sync_task.auto.retry_scheduled' : 'sync_task.auto.failed';
      const auditInput = { action, objectType: 'sync_tasks', objectId: taskId, settlementMonth: claim.settlementMonth,
        afterData: { ...this.auditSummary(claim), errorCategory: category, nextAttemptAt }, changedFields: ['status', 'nextAttemptAt', 'lastErrorCategory'],
        requestPayload: { triggerType: SyncTaskTriggerType.scheduled }, failureReason: category, errorMessage: safeMessage };
      if (retry) await this.audit.success(auditInput, tx); else await this.audit.failure(auditInput, tx);
    });
  }

  private auditSummary(task: ClaimedTask) {
    return { taskId: task.id, settlementMonth: task.settlementMonth.toISOString().slice(0, 10), sourceType: task.sourceType,
      platform: task.sourceType === SyncTaskSourceType.affiliate_income ? task.platform : undefined,
      provider: task.provider, attemptCount: task.attemptCount, triggerType: SyncTaskTriggerType.scheduled, system: true };
  }
}

function classifyUnexpected(error: unknown): SyncExecutionErrorCategory {
  if (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P2024', 'P2034'].includes(error.code)) return SyncExecutionErrorCategory.TEMPORARY_DATABASE_ERROR;
  return SyncExecutionErrorCategory.VALIDATION_ERROR;
}

function safeErrorMessage(error: unknown, category: SyncExecutionErrorCategory): string {
  if (error instanceof Error && !/credential|decrypt|secret|token|password|key/i.test(error.message)) return redact(error.message);
  return blockerMessage(category);
}

function blockerMessage(category: SyncExecutionErrorCategory): string {
  const messages: Partial<Record<SyncExecutionErrorCategory, string>> = {
    CREDENTIAL_MISSING: 'An active credential is required.', CREDENTIAL_INVALID: 'The provider rejected the configured credential.',
    MONTH_LOCKED: 'The settlement month is locked.', UNSUPPORTED_PLATFORM: 'The affiliate platform is not supported.',
    UNSUPPORTED_PROVIDER: 'The card provider is not supported.', BUSINESS_REJECTED: 'The task is no longer eligible for automatic execution.',
  };
  return messages[category] ?? 'Automatic sync execution failed.';
}

function redact(message: string): string {
  return message.replace(/(api[_-]?key|secret|token|password|authorization|client[_-]?id|merchant[_-]?id)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').slice(0, 1000);
}
