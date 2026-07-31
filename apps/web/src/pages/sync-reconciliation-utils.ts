export const AFFILIATE_PLATFORM_OPTIONS = [
  { label: 'Everflow', value: 'everflow' },
  { label: 'CAKE', value: 'cake' },
] as const;

export const CARD_PROVIDER_FILTER_OPTIONS = [
  { label: 'Airwallex', value: 'airwallex' },
  { label: 'PhotonPay', value: 'photonpay' },
] as const;

export const UNMATCHED_LIMITATION_NOTICE =
  '此处只显示未归属的收入/卡记录；CAKE 在写入收入前拦截的无 SUB、无映射、冲突、状态或时区异常记录，请到“同步未匹配事件”页面核对。';

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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.replace('T', ' ').slice(0, 19);
  const gmt8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${gmt8.toISOString().slice(0, 19).replace('T', ' ')} GMT+8`;
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
