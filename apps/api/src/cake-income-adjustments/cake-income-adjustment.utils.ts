import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

export const CAKE_BASE_SOURCE = 'cake';
export const CAKE_ADJUSTMENT_SOURCE = 'cake_adjustment';
export const CAKE_SUB_FIELD = 'sub1';

export type CakeAdjustmentMetadata = {
  kind: 'cake_sub_revenue_adjustment';
  basis: 'manual_china_standard_time';
  providerTimezone: 'cake_system_default';
  settlementTimezone: 'Asia/Shanghai';
  baseRevenueUsd: string;
  targetRevenueUsd: string;
  adjustmentUsd: string;
  beforeRevenueUsd: string;
  afterRevenueUsd: string;
  reason: string;
  stale: boolean;
  staleReason?: 'cake_base_revenue_changed' | 'cake_base_unavailable';
  previousBaseRevenueUsd?: string;
  currentBaseRevenueUsd?: string;
};

export function cakeAdjustmentExternalRecordId(
  affiliateAccountId: string,
  settlementMonth: Date,
  subValue: string,
) {
  const digest = createHash('sha256')
    .update(`${affiliateAccountId}|${formatMonth(settlementMonth)}|${subValue}`)
    .digest('hex');
  return `${CAKE_ADJUSTMENT_SOURCE}:${digest}`;
}

export function buildCakeAdjustmentMetadata(input: {
  baseRevenueUsd: Prisma.Decimal;
  actualRevenueUsd: Prisma.Decimal;
  adjustmentUsd: Prisma.Decimal;
  reason: string;
}): CakeAdjustmentMetadata {
  return {
    kind: 'cake_sub_revenue_adjustment',
    basis: 'manual_china_standard_time',
    providerTimezone: 'cake_system_default',
    settlementTimezone: 'Asia/Shanghai',
    baseRevenueUsd: input.baseRevenueUsd.toString(),
    targetRevenueUsd: input.actualRevenueUsd.toString(),
    adjustmentUsd: input.adjustmentUsd.toString(),
    beforeRevenueUsd: input.baseRevenueUsd.toString(),
    afterRevenueUsd: input.actualRevenueUsd.toString(),
    reason: input.reason,
    stale: false,
  };
}

export function readCakeAdjustmentMetadata(
  rawData: Prisma.JsonValue | null | undefined,
): CakeAdjustmentMetadata | null {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) return null;
  const value = rawData as Record<string, unknown>;
  if (value.kind !== 'cake_sub_revenue_adjustment') return null;
  if (
    typeof value.baseRevenueUsd !== 'string'
    || typeof value.targetRevenueUsd !== 'string'
    || typeof value.adjustmentUsd !== 'string'
    || typeof value.reason !== 'string'
  ) return null;
  return {
    ...(value as unknown as CakeAdjustmentMetadata),
    stale: value.stale === true,
  };
}

export function isStaleCakeAdjustment(rawData: Prisma.JsonValue | null | undefined) {
  return readCakeAdjustmentMetadata(rawData)?.stale === true;
}

function formatMonth(date: Date) {
  return date.toISOString().slice(0, 7);
}
