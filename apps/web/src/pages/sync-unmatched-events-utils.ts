import { safeJsonText } from './data-sync-utils';
import { buildQuery, formatDateTime, textValue } from './sync-reconciliation-utils';

export type SyncUnmatchedSourceType = 'affiliate_income' | 'card_spend';
export type SyncUnmatchedPlatform = 'everflow' | 'cake';
export type SyncUnmatchedProvider = 'airwallex' | 'photonpay';
export type SyncUnmatchedUiStatus = 'pending' | 'ignored' | 'resolved';
export type SyncUnmatchedApiStatus = 'open' | 'ignored' | 'resolved';

export type SyncUnmatchedEventFilters = {
  settlementMonth?: string;
  sourceType?: SyncUnmatchedSourceType;
  platform?: SyncUnmatchedPlatform;
  provider?: SyncUnmatchedProvider;
  reasonCode?: string;
  status?: SyncUnmatchedUiStatus;
};

export type SyncUnmatchedEventRow = {
  id: string;
  settlementMonth?: string | null;
  sourceType?: SyncUnmatchedSourceType | string | null;
  taskType?: string | null;
  platform?: SyncUnmatchedPlatform | string | null;
  provider?: SyncUnmatchedProvider | string | null;
  affiliateAccountId?: string | null;
  affiliateAccountName?: string | null;
  affiliateAccountCode?: string | null;
  syncTaskId?: string | null;
  thirdPartyEventId?: string | null;
  reasonCode?: string | null;
  reasonMessage?: string | null;
  subField?: string | null;
  subValue?: string | null;
  cardId?: string | null;
  cardLast4?: string | null;
  cardEmail?: string | null;
  amountUsd?: string | null;
  currency?: string | null;
  occurredAt?: string | null;
  rawSafeData?: unknown;
  status: SyncUnmatchedApiStatus | SyncUnmatchedUiStatus | string;
  resolvedEmployeeId?: string | null;
  resolvedEmployeeName?: string | null;
  resolutionNote?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
};

export type SyncUnmatchedSummary = {
  totalCount?: number;
  openCount?: number;
  pendingCount?: number;
  ignoredCount?: number;
  resolvedCount?: number;
  totalAmountUsd?: string | null;
  byReasonCode?: Record<string, number>;
  bySourceType?: Record<string, number>;
};

export const SOURCE_TYPE_OPTIONS = [
  { label: 'affiliate_income', value: 'affiliate_income' },
  { label: 'card_spend', value: 'card_spend' },
] as const;

export const UNMATCHED_PLATFORM_OPTIONS = [
  { label: 'everflow', value: 'everflow' },
  { label: 'cake', value: 'cake' },
] as const;

export const UNMATCHED_PROVIDER_OPTIONS = [
  { label: 'airwallex', value: 'airwallex' },
  { label: 'photonpay', value: 'photonpay' },
] as const;

export const UNMATCHED_STATUS_OPTIONS = [
  { label: 'pending', value: 'pending' },
  { label: 'ignored', value: 'ignored' },
  { label: 'resolved', value: 'resolved' },
] as const;

export const UNMATCHED_REASON_OPTIONS = [
  'SUB_ID_MISSING',
  'SUB_ID_NOT_MAPPED',
  'CARD_ID_MISSING',
  'CARD_NOT_MAPPED',
  'EMPLOYEE_DISABLED',
  'INVALID_CURRENCY',
  'OUTSIDE_SETTLEMENT_WINDOW',
  'DUPLICATE_SKIPPED',
  'UNKNOWN',
].map((value) => ({ label: value, value }));

export function apiStatusFromUi(status?: SyncUnmatchedUiStatus): SyncUnmatchedApiStatus | undefined {
  if (!status) return undefined;
  return status === 'pending' ? 'open' : status;
}

export function uiStatusFromApi(status: unknown): SyncUnmatchedUiStatus | string {
  return status === 'open' ? 'pending' : textValue(status);
}

export function isPendingUnmatchedEvent(record: Pick<SyncUnmatchedEventRow, 'status'>): boolean {
  return record.status === 'open' || record.status === 'pending';
}

export function unmatchedStatusColor(status: unknown): string {
  const uiStatus = uiStatusFromApi(status);
  if (uiStatus === 'pending') return 'blue';
  if (uiStatus === 'ignored') return 'orange';
  if (uiStatus === 'resolved') return 'green';
  return 'default';
}

export function buildSyncUnmatchedEventsQuery(
  filters: SyncUnmatchedEventFilters,
  page: number,
  pageSize: number,
): string {
  return buildQuery({
    ...filters,
    status: apiStatusFromUi(filters.status),
    page,
    pageSize,
  });
}

export function formatSettlementMonth(value: unknown): string {
  if (typeof value !== 'string' || !value) return '-';
  return value.slice(0, 7);
}

export function formatUnmatchedDateTime(value: unknown): string {
  return formatDateTime(value);
}

export function rawSafeDataText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  return safeJsonText(value);
}

export function countValue(value: unknown): number | string {
  return typeof value === 'number' ? value : '-';
}
