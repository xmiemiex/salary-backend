import { Injectable } from '@nestjs/common';
import {
  CommonStatus,
  Prisma,
  Provider,
  SyncPlanningRunStatus,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskStatus,
  SyncTaskTriggerType,
  SyncTaskType,
} from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { getPreviousGmt8Month, monthText, readSyncPlannerConfig } from './sync-planner-config';

export type PlanningBlockerCode =
  | 'MONTH_LOCKED' | 'CREDENTIAL_MISSING' | 'ACCOUNT_DISABLED'
  | 'TASK_ALREADY_EXISTS' | 'UNSUPPORTED_PLATFORM' | 'UNSUPPORTED_PROVIDER';

export type PlanningCandidate = {
  sourceType: SyncTaskSourceType;
  taskType: SyncTaskType;
  settlementMonth: string;
  affiliateAccountId: string | null;
  affiliateAccountName: string | null;
  platform: SyncTaskPlatform | string | null;
  provider: Provider | string | null;
  credentialConfigured: boolean;
  credentialId: string | null;
  existingTaskId: string | null;
  canCreate: boolean;
  blockerCodes: PlanningBlockerCode[];
  planningKey: string;
};

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class SyncPlanningService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async preview(settlementMonthInput: string) {
    const result = await this.buildPreview(this.prisma, parseMonth(settlementMonthInput));
    return { ...result, candidates: result.candidates.map(publicCandidate) };
  }

  async generate(settlementMonthInput: string, actor: Actor | null, triggerType: SyncTaskTriggerType) {
    const month = parseMonth(settlementMonthInput);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sync-planning:${monthText(month)}`}, 0))`;
        const preview = await this.buildPreview(tx, month);
        if (preview.locked && triggerType === SyncTaskTriggerType.manual) {
          throw new AppError(ERROR_CODES.MONTH_LOCKED, 'Settlement month is locked and cannot be planned.');
        }

        const created: Array<{ id: string; planningKey: string }> = [];
        for (const candidate of preview.candidates.filter((item) => item.canCreate)) {
          const task = await tx.syncTask.create({
            data: {
              sourceType: candidate.sourceType,
              taskType: candidate.taskType,
              platform: candidate.platform as SyncTaskPlatform,
              affiliateAccountId: candidate.affiliateAccountId,
              provider: candidate.provider as Provider | null,
              settlementMonth: month,
              status: SyncTaskStatus.pending,
              requestedBy: actor?.userId ?? null,
              triggerType,
              planningKey: candidate.planningKey,
              requestPayload: {
                settlementMonth: monthText(month),
                credentialId: candidate.credentialId,
              },
            },
            select: { id: true, planningKey: true },
          });
          created.push({ id: task.id, planningKey: task.planningKey! });
        }

        const existing = preview.candidates.filter((item) => item.blockerCodes.includes('TASK_ALREADY_EXISTS'));
        const blocked = preview.candidates.filter((item) => !item.canCreate && !item.blockerCodes.includes('TASK_ALREADY_EXISTS'));
        const blockerCodes = [...new Set(blocked.flatMap((item) => item.blockerCodes))];
        const summary = { triggerType, settlementMonth: monthText(month), createdCount: created.length, existingCount: existing.length, blockedCount: blocked.length, blockerCodes };
        await this.audit.success({
          actorUserId: actor?.userId,
          actorRole: actor?.roleCode ?? 'system',
          action: 'sync_planning.generate', objectType: 'sync_planning', objectId: monthText(month), settlementMonth: month,
          afterData: summary, changedFields: ['createdCount'], requestPayload: { triggerType, settlementMonth: monthText(month) },
          ipAddress: actor?.ipAddress, userAgent: actor?.userAgent,
        }, tx);
        return { settlementMonth: monthText(month), triggerType, created, existing: existing.map(publicCandidate), blocked: blocked.map(publicCandidate), summary };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof AppError && error.code === ERROR_CODES.MONTH_LOCKED) {
        await this.audit.failure({
          actorUserId: actor?.userId, actorRole: actor?.roleCode ?? 'system', action: 'sync_planning.generate',
          objectType: 'sync_planning', objectId: monthText(month), settlementMonth: month,
          requestPayload: { triggerType, settlementMonth: monthText(month) }, failureReason: 'MONTH_LOCKED',
          errorMessage: 'Settlement month is locked.', ipAddress: actor?.ipAddress, userAgent: actor?.userAgent,
        });
      }
      throw error;
    }
  }

  async status() {
    const config = readSyncPlannerConfig();
    const latest = await this.prisma.syncPlanningRun.findFirst({ orderBy: { lastAttemptAt: 'desc' } });
    return {
      enabled: config.enabled, configuredDay: config.day, configuredHour: config.hour, timezone: config.timezone,
      currentTargetMonth: monthText(getPreviousGmt8Month()), lastAttemptAt: latest?.lastAttemptAt ?? null,
      lastSuccessAt: latest?.lastSuccessAt ?? null,
      lastResult: latest ? { status: latest.status, settlementMonth: monthText(latest.settlementMonth), createdCount: latest.createdCount, existingCount: latest.existingCount, blockedCount: latest.blockedCount, blockerCodes: latest.blockerCodes, failureCode: latest.failureCode } : null,
    };
  }

  private async buildPreview(db: Db, month: Date) {
    const [settlement, accounts, providerCredentials, existingTasks] = await Promise.all([
      db.monthlySettlement.findUnique({ where: { settlementMonth: month }, select: { status: true } }),
      db.affiliateAccount.findMany({
        where: { status: CommonStatus.active }, orderBy: { createdAt: 'asc' },
        select: { id: true, platform: true, accountCode: true, accountName: true, status: true, credential: { select: { id: true, status: true } } },
      }),
      db.cardProviderCredential.findMany({ where: { provider: { in: [Provider.airwallex, Provider.photonpay] } }, select: { id: true, provider: true, status: true } }),
      db.syncTask.findMany({ where: { settlementMonth: month }, select: { id: true, sourceType: true, affiliateAccountId: true, provider: true, status: true } }),
    ]);
    const locked = settlement?.status === 'locked';
    const candidates: PlanningCandidate[] = [];
    for (const account of accounts) {
      const platform = account.platform.trim().toLowerCase();
      const supported = platform === SyncTaskPlatform.everflow || platform === SyncTaskPlatform.cake;
      const credential = account.credential?.status === CommonStatus.active ? account.credential : null;
      const existing = existingTasks.find((task) => task.sourceType === SyncTaskSourceType.affiliate_income && task.affiliateAccountId === account.id);
      const blockers: PlanningBlockerCode[] = [];
      if (locked) blockers.push('MONTH_LOCKED');
      if (!supported) blockers.push('UNSUPPORTED_PLATFORM');
      if (!credential) blockers.push('CREDENTIAL_MISSING');
      if (existing) blockers.push('TASK_ALREADY_EXISTS');
      candidates.push({ sourceType: SyncTaskSourceType.affiliate_income, taskType: SyncTaskType.affiliate_income, settlementMonth: monthText(month), affiliateAccountId: account.id, affiliateAccountName: account.accountName ?? account.accountCode, platform, provider: null, credentialConfigured: Boolean(credential), credentialId: credential?.id ?? null, existingTaskId: existing?.id ?? null, canCreate: blockers.length === 0, blockerCodes: blockers, planningKey: `sync-plan:${monthText(month)}:affiliate:${account.id}` });
    }
    for (const provider of [Provider.airwallex, Provider.photonpay]) {
      const credential = providerCredentials.find((item) => item.provider === provider && item.status === CommonStatus.active);
      const existing = existingTasks.find((task) => task.sourceType === SyncTaskSourceType.card_spend && task.provider === provider);
      const blockers: PlanningBlockerCode[] = [];
      if (locked) blockers.push('MONTH_LOCKED');
      if (!credential) blockers.push('CREDENTIAL_MISSING');
      if (existing) blockers.push('TASK_ALREADY_EXISTS');
      candidates.push({ sourceType: SyncTaskSourceType.card_spend, taskType: provider === Provider.airwallex ? SyncTaskType.airwallex_card : SyncTaskType.photonpay_card, settlementMonth: monthText(month), affiliateAccountId: null, affiliateAccountName: null, platform: provider, provider, credentialConfigured: Boolean(credential), credentialId: credential?.id ?? null, existingTaskId: existing?.id ?? null, canCreate: blockers.length === 0, blockerCodes: blockers, planningKey: `sync-plan:${monthText(month)}:card:${provider}` });
    }
    const existing = candidates.filter((item) => item.existingTaskId).map(publicCandidate);
    const blocked = candidates.filter((item) => !item.canCreate && !item.existingTaskId).map(publicCandidate);
    return { settlementMonth: monthText(month), locked, candidates, existingTasks: existing, blockers: blocked, summary: { candidateCount: candidates.length, creatableCount: candidates.filter((item) => item.canCreate).length, existingCount: existing.length, blockedCount: blocked.length } };
  }
}

function publicCandidate(candidate: PlanningCandidate) {
  const { credentialId: _credentialId, planningKey: _planningKey, ...safe } = candidate;
  return safe;
}

export function parseMonth(value: string): Date {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? '');
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'settlementMonth must use YYYY-MM format.');
  return new Date(Date.UTC(Number(match[1]), month - 1, 1));
}
