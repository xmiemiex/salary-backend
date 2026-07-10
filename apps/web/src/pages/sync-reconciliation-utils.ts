export const AFFILIATE_PLATFORM_OPTIONS = [
  { label: 'Everflow', value: 'everflow' },
  { label: 'CAKE', value: 'cake' },
] as const;

export const CARD_PROVIDER_FILTER_OPTIONS = [
  { label: 'Airwallex', value: 'airwallex' },
  { label: 'PhotonPay', value: 'photonpay' },
] as const;

export const UNMATCHED_LIMITATION_NOTICE =
  '当前只显示数据库中已有的未归属记录；由于同步 adapter 对未映射第三方记录会跳过写库，这不是完整的第三方未匹配明细。';

export const EMPLOYEE_SUMMARY_COLUMNS = [
  'employeeName',
  'employeeId',
  'affiliateRevenueUsd',
  'apiCardSpendUsd',
  'manualCardSpendUsd',
  'rawGrossProfitUsd',
  'unmatchedFlags',
  'warnings',
] as const;

export function defaultGmt8Month(now = new Date()): string {
  const gmt8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return `${gmt8.getUTCFullYear()}-${String(gmt8.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function displaySyncTaskId(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '无真实任务关联';
}

export function isNegativeUsd(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed < 0;
}

export function formatDateTime(value: unknown): string {
  if (typeof value !== 'string' || !value) return '-';
  return value.replace('T', ' ').slice(0, 19);
}

export function textValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  return String(value);
}

export function buildQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.set(key, String(value));
  });
  return search.toString();
}
