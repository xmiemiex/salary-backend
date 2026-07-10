import { Injectable } from '@nestjs/common';
import {
  CommonStatus,
  Prisma,
  Provider,
  SettlementStatus,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskStatus,
  SyncUnmatchedEventStatus,
} from '@prisma/client';
import { Actor } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatSettlementMonth,
  getCurrentSettlementMonth,
  parseSettlementMonthParam,
} from '../settlement/settlement-month.util';
import { SyncReconciliationService } from '../sync-reconciliation/sync-reconciliation.service';

const SYNC_VIEW = ['salary.view_all', 'income.import', 'manual_card_spend.manage'];
const SETTLEMENT_VIEW = ['salary.view_all'];
const RUNNING_TOO_LONG_MS = 30 * 60 * 1000;
const QUERY_TIMEOUT_MS = 10_000;
const ZERO = new Prisma.Decimal(0);

type TodoSeverity = 'info' | 'warning' | 'error';
export type DashboardTodo = {
  code: string;
  severity: TodoSeverity;
  title: string;
  description: string;
  count: number;
  targetPath: string;
};

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: SyncReconciliationService,
  ) {}

  async overview(monthInput: string | undefined, actor: Actor) {
    const settlementMonth = monthInput === undefined
      ? getCurrentSettlementMonth()
      : parseSettlementMonthParam(monthInput);
    const month = formatSettlementMonth(settlementMonth);
    const permissions = new Set(actor.permissions);
    const canViewSync = hasAny(permissions, SYNC_VIEW);
    const canViewReconciliation = permissions.has('salary.view_all');
    const canViewUnmatched = permissions.has('salary.view_all');
    const canViewSettlement = hasAny(permissions, SETTLEMENT_VIEW);

    const result: Record<string, unknown> = {
      settlementMonth: month,
      refreshedAt: new Date(),
      permissions: { sync: canViewSync, reconciliation: canViewReconciliation, unmatched: canViewUnmatched, settlement: canViewSettlement },
      todos: [] as DashboardTodo[],
    };

    const jobs: Promise<void>[] = [];
    const sectionErrors: Record<string, string> = {};
    let sync: Awaited<ReturnType<DashboardService['readSync']>> | undefined;
    let unmatched: Awaited<ReturnType<DashboardService['readUnmatched']>> | undefined;
    let settlement: Awaited<ReturnType<DashboardService['readSettlement']>> | undefined;

    const section = (name: string, job: Promise<void>) => jobs.push(job.catch(() => { sectionErrors[name] = 'QUERY_FAILED'; }));
    if (canViewSync) section('sync', this.readSync(settlementMonth).then((value) => { sync = value; result.sync = value; }));
    if (canViewReconciliation) section('reconciliation', this.readReconciliation(month).then((value) => { result.reconciliation = value; }));
    if (canViewUnmatched) section('unmatched', this.readUnmatched(settlementMonth).then((value) => { unmatched = value; result.unmatched = value; }));
    if (canViewSettlement) section('settlement', this.readSettlement(settlementMonth).then((value) => { settlement = value; result.monthStatus = value.monthStatus; result.employeesAndSettlement = value.employeesAndSettlement; }));

    await withTimeout(Promise.all(jobs), QUERY_TIMEOUT_MS);
    if (Object.keys(sectionErrors).length) result.sectionErrors = sectionErrors;
    result.todos = buildTodos({ sync, unmatched, settlement, permissions });
    return result;
  }

  private async readSync(settlementMonth: Date) {
    const tasks = await this.prisma.syncTask.findMany({
      where: { settlementMonth },
      select: { status: true, platform: true, provider: true, affiliateAccountId: true, startedAt: true, finishedAt: true, createdAt: true },
    });
    const statuses = Object.values(SyncTaskStatus);
    const count = (status: SyncTaskStatus) => tasks.filter((task) => task.status === status).length;
    const platformGroups = [SyncTaskPlatform.everflow, SyncTaskPlatform.cake, SyncTaskPlatform.airwallex, SyncTaskPlatform.photonpay]
      .map((platform) => ({
        platform,
        taskCount: tasks.filter((task) => task.platform === platform).length,
        statuses: Object.fromEntries(statuses.map((status) => [status, tasks.filter((task) => task.platform === platform && task.status === status).length])),
      }));
    const successful = tasks.filter((task) => task.status === SyncTaskStatus.completed).map((task) => task.finishedAt ?? task.createdAt);
    const failed = tasks.filter((task) => task.status === SyncTaskStatus.failed).map((task) => task.finishedAt ?? task.createdAt);
    const now = Date.now();
    return {
      taskCount: tasks.length,
      pendingCount: count(SyncTaskStatus.pending),
      runningCount: count(SyncTaskStatus.running),
      completedCount: count(SyncTaskStatus.completed),
      failedCount: count(SyncTaskStatus.failed),
      cancelledCount: count(SyncTaskStatus.cancelled),
      lastSuccessfulSyncAt: maxDate(successful),
      lastFailedSyncAt: maxDate(failed),
      runningTooLongCount: tasks.filter((task) => task.status === SyncTaskStatus.running && now - (task.startedAt ?? task.createdAt).getTime() >= RUNNING_TOO_LONG_MS).length,
      byPlatform: platformGroups,
    };
  }

  private async readReconciliation(settlementMonth: string) {
    const [income, spend, employees] = await Promise.all([
      this.reconciliation.affiliateIncome({ settlementMonth, page: '1', pageSize: '1' }),
      this.reconciliation.cardSpend({ settlementMonth, page: '1', pageSize: '1' }),
      this.reconciliation.monthlyEmployeeSummary({ settlementMonth }),
    ]);
    const sum = (key: 'affiliateRevenueUsd' | 'apiCardSpendUsd' | 'manualCardSpendUsd' | 'rawGrossProfitUsd') =>
      employees.reduce((total, row) => total.plus(row[key]), ZERO).toString();
    return {
      affiliateRevenueUsd: sum('affiliateRevenueUsd'),
      apiCardSpendUsd: sum('apiCardSpendUsd'),
      manualCardSpendUsd: sum('manualCardSpendUsd'),
      rawGrossProfitUsd: sum('rawGrossProfitUsd'),
      matchedRevenueUsd: income.summary.matchedRevenueUsd,
      unmatchedRevenueUsd: income.summary.unmatchedRevenueUsd,
      matchedSpendUsd: spend.summary.matchedSpendUsd,
      unmatchedSpendUsd: spend.summary.unmatchedSpendUsd,
    };
  }

  private async readUnmatched(settlementMonth: Date) {
    const where = { settlementMonth, status: SyncUnmatchedEventStatus.open };
    const [aggregate, byReason, bySource] = await this.prisma.$transaction([
      this.prisma.syncUnmatchedEvent.aggregate({ where, _count: { _all: true }, _min: { createdAt: true }, _max: { createdAt: true } }),
      this.prisma.syncUnmatchedEvent.groupBy({ by: ['reasonCode'], where, _count: true, orderBy: { reasonCode: 'asc' } }),
      this.prisma.syncUnmatchedEvent.groupBy({ by: ['sourceType'], where, _count: true, orderBy: { sourceType: 'asc' } }),
    ]);
    const sourceCount = (source: SyncTaskSourceType): number => Number(bySource.find((item) => item.sourceType === source)?._count ?? 0);
    return {
      totalCount: aggregate._count._all,
      affiliateIncomeCount: sourceCount(SyncTaskSourceType.affiliate_income),
      cardSpendCount: sourceCount(SyncTaskSourceType.card_spend),
      byReason: Object.fromEntries(byReason.map((item) => [item.reasonCode, Number(item._count)])),
      oldestUnresolvedAt: aggregate._min.createdAt,
      latestUnresolvedAt: aggregate._max.createdAt,
    };
  }

  private async readSettlement(settlementMonth: Date) {
    const [settlement, activeEmployeeCount, revenueEmployees, spendEmployees, manualSpendEmployees, exchangeRate, feeRates, sourceChanges] = await Promise.all([
      this.prisma.monthlySettlement.findUnique({
        where: { settlementMonth },
        select: {
          id: true, status: true, generatedAt: true, confirmedAt: true, lockedAt: true, lockedBy: true,
          details: { select: { employeeId: true, finalSalaryRmb: true } },
        },
      }),
      this.prisma.employee.count({ where: { status: CommonStatus.active } }),
      this.prisma.incomeRecord.groupBy({ by: ['employeeId'], where: { settlementMonth, source: { in: ['everflow', 'cake'] }, employeeId: { not: null } }, orderBy: { employeeId: 'asc' } }),
      this.prisma.cardSpendEvent.groupBy({ by: ['employeeId'], where: { settlementMonth, employeeId: { not: null } }, orderBy: { employeeId: 'asc' } }),
      this.prisma.manualCardSpendEntry.groupBy({ by: ['employeeId'], where: { settlementMonth, status: SettlementStatus.confirmed }, orderBy: { employeeId: 'asc' } }),
      this.prisma.monthlyExchangeRate.findFirst({ where: { settlementMonth, status: { in: [CommonStatus.active, CommonStatus.confirmed] } }, select: { id: true } }),
      this.prisma.monthlyCardProviderFeeRate.findMany({ where: { settlementMonth, status: { in: [CommonStatus.active, CommonStatus.confirmed] } }, select: { provider: true } }),
      this.readLatestSourceChange(settlementMonth),
    ]);
    const locker = settlement?.lockedBy ? await this.prisma.adminUser.findUnique({ where: { id: settlement.lockedBy }, select: { id: true, displayName: true } }) : null;
    const feeProviderSet = new Set(feeRates.map((rate) => rate.provider));
    const spendProviders = await this.prisma.cardSpendEvent.findMany({ where: { settlementMonth, status: CommonStatus.confirmed }, distinct: ['provider'], select: { provider: true } });
    const missingFeeProviders = spendProviders.map((row) => row.provider).filter((provider) => !feeProviderSet.has(provider));
    const totalSalaryRmb = settlement?.details.reduce((total, detail) => total.plus(detail.finalSalaryRmb), ZERO).toString() ?? '0';
    return {
      monthStatus: {
        settlementMonth: formatSettlementMonth(settlementMonth),
        isLocked: settlement?.status === SettlementStatus.locked,
        lockedAt: settlement?.lockedAt ?? null,
        lockedBy: locker,
        settlementStatus: settlement?.status ?? 'not_generated',
        generatedAt: settlement?.generatedAt ?? null,
        finalizedAt: settlement?.confirmedAt ?? null,
        exportedAt: null,
      },
      employeesAndSettlement: {
        activeEmployeeCount,
        employeesWithRevenueCount: revenueEmployees.length,
        employeesWithSpendCount: new Set([...spendEmployees.map((row) => row.employeeId), ...manualSpendEmployees.map((row) => row.employeeId)]).size,
        settlementDetailCount: settlement?.details.length ?? 0,
        totalSalaryRmb,
        settlementStatus: settlement?.status ?? 'not_generated',
      },
      missingExchangeRate: !exchangeRate,
      missingFeeProviders,
      isOutdated: Boolean(settlement?.generatedAt && sourceChanges && sourceChanges > settlement.generatedAt),
    };
  }

  private async readLatestSourceChange(settlementMonth: Date): Promise<Date | null> {
    const results = await Promise.all([
      this.prisma.incomeRecord.findFirst({ where: { settlementMonth }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.cardSpendEvent.findFirst({ where: { settlementMonth }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.manualCardSpendEntry.findFirst({ where: { settlementMonth }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.monthlyExchangeRate.findFirst({ where: { settlementMonth }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.monthlyCardProviderFeeRate.findFirst({ where: { settlementMonth }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.monthlySalaryManualItem.findFirst({ where: { settlementMonth }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.historicalNegativeProfit.findFirst({ where: { settlementMonth }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.monthlyPerformanceGroup.findFirst({ where: { settlementMonth }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.monthlyPerformanceGroupMember.findFirst({ where: { settlementMonth }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ]);
    return maxDate(results.map((result) => result && ('updatedAt' in result ? result.updatedAt : result.createdAt)).filter((value): value is Date => Boolean(value)));
  }
}

export function buildTodos(input: {
  sync?: { taskCount: number; pendingCount: number; runningCount: number; failedCount: number; runningTooLongCount: number };
  unmatched?: { affiliateIncomeCount: number; cardSpendCount: number };
  settlement?: { monthStatus: { isLocked: boolean; settlementStatus: string }; missingExchangeRate: boolean; missingFeeProviders: Provider[]; isOutdated: boolean };
  permissions: Set<string>;
}): DashboardTodo[] {
  const todos: DashboardTodo[] = [];
  const add = (condition: boolean, code: string, severity: TodoSeverity, title: string, description: string, count: number, targetPath: string) => {
    if (condition) todos.push({ code, severity, title, description, count, targetPath });
  };
  if (input.sync) {
    add(input.sync.taskCount === 0, 'SYNC_NOT_CREATED', 'warning', '尚未创建同步任务', '当前月份没有同步任务。', 0, '/data-sync');
    add(input.sync.pendingCount > 0, 'SYNC_PENDING', 'warning', '同步任务待执行', '存在待执行的同步任务。', input.sync.pendingCount, '/data-sync');
    add(input.sync.runningTooLongCount > 0, 'SYNC_RUNNING_TOO_LONG', 'error', '同步运行超时', '同步任务已连续运行至少 30 分钟。', input.sync.runningTooLongCount, '/data-sync');
    add(input.sync.failedCount > 0, 'SYNC_FAILED', 'error', '同步任务失败', '存在失败的同步任务，请查看已脱敏错误信息。', input.sync.failedCount, '/data-sync');
  }
  if (input.unmatched) {
    add(input.unmatched.affiliateIncomeCount > 0, 'UNMATCHED_AFFILIATE_INCOME', 'warning', '联盟收入未匹配', '存在未解决的联盟收入事件。', input.unmatched.affiliateIncomeCount, '/sync-unmatched-events');
    add(input.unmatched.cardSpendCount > 0, 'UNMATCHED_CARD_SPEND', 'warning', '卡花费未匹配', '存在未解决的卡花费事件。', input.unmatched.cardSpendCount, '/sync-unmatched-events');
  }
  if (input.settlement) {
    add(input.settlement.missingExchangeRate && input.permissions.has('monthly_exchange_rate.manage'), 'MISSING_EXCHANGE_RATE', 'error', '缺少月度汇率', '当前月份没有有效汇率配置。', 1, '/monthly-exchange-rates');
    add(input.settlement.missingFeeProviders.length > 0 && input.permissions.has('card_provider_fee_rate.manage'), 'MISSING_CARD_PROVIDER_FEE_RATE', 'error', '缺少卡手续费率', '存在已确认卡花费但缺少对应 provider 手续费率。', input.settlement.missingFeeProviders.length, '/card-provider-fee-rates');
    add(input.settlement.monthStatus.settlementStatus === 'not_generated', 'SETTLEMENT_NOT_GENERATED', 'warning', '结算尚未生成', '当前月份没有正式结算快照。', 1, '/salary-settlements');
    add(input.settlement.isOutdated, 'SETTLEMENT_OUTDATED', 'error', '结算已过期', '结算生成后，月度源数据或配置发生了更新。', 1, '/salary-settlements');
    add(!input.settlement.monthStatus.isLocked, 'MONTH_NOT_LOCKED', 'warning', '月份尚未锁账', '当前结算月份仍可修改。', 1, '/salary-settlements');
    add(input.settlement.monthStatus.isLocked, 'MONTH_LOCKED', 'info', '月份已锁账', '当前结算月份已锁账，仅允许只读查看。', 1, '/salary-settlements');
  }
  return todos;
}

function hasAny(permissions: Set<string>, required: string[]) { return required.some((permission) => permissions.has(permission)); }
function maxDate(values: Date[]): Date | null { return values.length ? new Date(Math.max(...values.map((value) => value.getTime()))) : null; }
async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('Dashboard query timed out.')), milliseconds); })]);
  } finally {
    clearTimeout(timer!);
  }
}
