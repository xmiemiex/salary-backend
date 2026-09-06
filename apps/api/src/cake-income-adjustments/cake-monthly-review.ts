import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { CAKE_ADJUSTMENT_SOURCE, CAKE_BASE_SOURCE, readCakeAdjustmentMetadata } from './cake-income-adjustment.utils';

type BaseRow = { subField: string | null; subValue: string | null; incomeUsd: Prisma.Decimal };
type Adjustment = BaseRow & { status: string; rawData: Prisma.JsonValue | null };
type Confirmation = { baseFingerprint: string; confirmedAt: Date; confirmedBy: string } | null;
export type CakeMonthlyReviewReader = Pick<Prisma.TransactionClient, 'incomeRecord' | 'cakeMonthlyIncomeReview'>;

function aggregateBase(rows: BaseRow[]) {
  const amounts = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    const key = JSON.stringify([row.subField, row.subValue]);
    amounts.set(key, (amounts.get(key) ?? new Prisma.Decimal(0)).plus(row.incomeUsd));
  }
  return amounts;
}

export function cakeBaseFingerprint(rows: BaseRow[]) {
  const entries = [...aggregateBase(rows)].map(([key, amount]) => [key, amount.toString()]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash('sha256').update(JSON.stringify({ version: 1, entries })).digest('hex');
}

export function summarizeCakeMonthlyReview(baseRows: BaseRow[], adjustments: Adjustment[], confirmation: Confirmation) {
  const fingerprint = cakeBaseFingerprint(baseRows);
  const amounts = aggregateBase(baseRows);
  let confirmedAdjustmentCount = 0, staleAdjustmentCount = 0;
  for (const row of adjustments) {
    const metadata = readCakeAdjustmentMetadata(row.rawData);
    // The adapter downgrades stale confirmed adjustments to draft: preserve that
    // explicit pending-review signal, but ordinary drafts/disabled rows prove nothing.
    if (row.status === 'draft' && metadata?.stale) { staleAdjustmentCount++; continue; }
    if (row.status !== 'confirmed') continue;
    const current = amounts.get(JSON.stringify([row.subField, row.subValue]));
    try {
      if (!metadata || metadata.stale || !current || !current.equals(metadata.baseRevenueUsd)) staleAdjustmentCount++;
      else confirmedAdjustmentCount++;
    } catch { staleAdjustmentCount++; }
  }
  const staleConfirmation = !!confirmation && confirmation.baseFingerprint !== fingerprint;
  const status = staleConfirmation || staleAdjustmentCount > 0 ? 'needs_review'
    : confirmedAdjustmentCount > 0 ? 'adjusted'
    : confirmation ? 'confirmed_no_adjustment' : 'unreviewed';
  return {
    status,
    label: { unreviewed: '未核对', confirmed_no_adjustment: '已核对无需调整', adjusted: '已有已确认调整', needs_review: '待复核' }[status],
    reason: staleConfirmation ? '原生佣金已变化，请重新核对' : staleAdjustmentCount > 0 ? '调整的原生佣金基准已变化或核对依据缺失' : null,
    confirmedAt: confirmation?.confirmedAt ?? null,
    confirmedBy: confirmation?.confirmedBy ?? null,
    confirmedAdjustmentCount, staleAdjustmentCount,
    // Legacy SUB adjustments do not certify other SUBs or a complete monthly scan.
    basis: confirmedAdjustmentCount > 0 ? 'confirmed_sub_adjustments' : confirmation ? 'account_month_native_fingerprint' : null,
    baseFingerprint: fingerprint,
  };
}

export async function readCakeMonthlyReview(db: CakeMonthlyReviewReader, affiliateAccountId: string, settlementMonth: Date) {
  const [baseRows, adjustments, confirmation] = await Promise.all([
    db.incomeRecord.findMany({ where: { affiliateAccountId, settlementMonth, source: CAKE_BASE_SOURCE, status: 'confirmed' }, select: { subField: true, subValue: true, incomeUsd: true } }),
    db.incomeRecord.findMany({ where: { affiliateAccountId, settlementMonth, source: CAKE_ADJUSTMENT_SOURCE, status: { in: ['confirmed', 'draft'] } }, select: { subField: true, subValue: true, incomeUsd: true, status: true, rawData: true } }),
    db.cakeMonthlyIncomeReview.findUnique({ where: { affiliateAccountId_settlementMonth: { affiliateAccountId, settlementMonth } } }),
  ]);
  return summarizeCakeMonthlyReview(baseRows, adjustments, confirmation);
}
