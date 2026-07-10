import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma, SyncPlanningRunStatus, SyncTaskTriggerType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getPreviousGmt8Month, isPlannerDue, monthText, readSyncPlannerConfig } from './sync-planner-config';
import { SyncPlanningService } from './sync-planning.service';

@Injectable()
export class SyncPlannerScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SyncPlannerScheduler.name);
  private readonly config = readSyncPlannerConfig();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly prisma: PrismaService, private readonly planning: SyncPlanningService) {}

  onApplicationBootstrap() {
    if (!this.config.enabled) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), 5 * 60 * 1000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async check(now = new Date()) {
    if (!isPlannerDue(this.config, now)) return { executed: false as const, reason: 'NOT_DUE' };
    const month = getPreviousGmt8Month(now);
    const claimed = await this.claim(month, now);
    if (!claimed) return { executed: false as const, reason: 'ALREADY_SUCCEEDED_OR_RUNNING' };
    try {
      const result = await this.planning.generate(monthText(month), null, SyncTaskTriggerType.scheduled);
      await this.prisma.syncPlanningRun.update({ where: { settlementMonth: month }, data: { status: SyncPlanningRunStatus.succeeded, lastSuccessAt: new Date(), createdCount: result.summary.createdCount, existingCount: result.summary.existingCount, blockedCount: result.summary.blockedCount, blockerCodes: result.summary.blockerCodes, failureCode: null } });
      return { executed: true as const, result: result.summary };
    } catch (error) {
      await this.prisma.syncPlanningRun.update({ where: { settlementMonth: month }, data: { status: SyncPlanningRunStatus.failed, failureCode: 'PLANNING_FAILED' } }).catch(() => undefined);
      this.logger.error(`Sync planning failed for ${monthText(month)}.`);
      return { executed: true as const, failed: true as const };
    }
  }

  private async claim(month: Date, now: Date) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sync-planner-run:${monthText(month)}`}, 0))`;
      const run = await tx.syncPlanningRun.findUnique({ where: { settlementMonth: month } });
      if (run?.status === SyncPlanningRunStatus.succeeded) return false;
      if (run?.status === SyncPlanningRunStatus.running && now.getTime() - run.lastAttemptAt.getTime() < 10 * 60 * 1000) return false;
      await tx.syncPlanningRun.upsert({ where: { settlementMonth: month }, create: { settlementMonth: month, status: SyncPlanningRunStatus.running, lastAttemptAt: now }, update: { status: SyncPlanningRunStatus.running, lastAttemptAt: now, attemptCount: { increment: 1 }, failureCode: null } });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
