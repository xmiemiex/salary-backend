import type { ReactNode } from 'react';

export type SyncType = 'affiliate_income' | 'airwallex_card' | 'photonpay_card' | 'task_records';
export type SyncTaskStatus = 'not_implemented' | 'pending' | 'retry_wait' | 'running' | 'completed' | 'failed' | 'cancelled';
export type CredentialStatus = 'active' | 'disabled' | string;

export type SyncOption = {
  value: SyncType;
  label: string;
  affectsSalary: boolean;
  taskType?: Exclude<SyncType, 'task_records'>;
  endpoint?: string;
  notice: string;
};

export type SafeJsonNode =
  | null
  | string
  | number
  | boolean
  | SafeJsonNode[]
  | { [key: string]: SafeJsonNode };

export type CredentialSummary = {
  hasCredential: boolean;
  status?: CredentialStatus | null;
  maskedPayload?: unknown;
};

const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'secret',
  'clientid',
  'client_id',
  'clientsecret',
  'client_secret',
  'merchantid',
  'merchant_id',
  'authorization',
  'accesskey',
  'access_key',
  'privatekey',
  'private_key',
  'signature',
  'password',
  'credential',
  'credentials',
  'encryptedpayload',
  'encrypted_payload',
  'cvv',
  'cardnumber',
  'card_number',
  'payload',
]);

export const SYNC_OPTIONS: SyncOption[] = [
  {
    value: 'affiliate_income',
    label: '联盟收入同步',
    affectsSalary: true,
    taskType: 'affiliate_income',
    endpoint: '/sync-tasks/affiliate-income',
    notice: '联盟收入平台仅支持 Everflow / CAKE；创建任务时选择具体联盟账号，平台由后端根据账号判断。',
  },
  {
    value: 'airwallex_card',
    label: 'Airwallex 虚拟卡同步',
    affectsSalary: true,
    taskType: 'airwallex_card',
    endpoint: '/sync-tasks/card-spend/airwallex',
    notice: 'Airwallex 虚拟卡同步按 requestWindow 拉取 API 数据，并按 transactionAt 的 GMT+8 月份归属 settlementWindow。',
  },
  {
    value: 'photonpay_card',
    label: 'PhotonPay 虚拟卡同步',
    affectsSalary: true,
    taskType: 'photonpay_card',
    endpoint: '/sync-tasks/card-spend/photonpay',
    notice: 'PhotonPay 虚拟卡同步按 requestWindow 拉取 API 数据，并按 transactionAt 的 GMT+8 月份归属 settlementWindow。',
  },
  {
    value: 'task_records',
    label: '同步任务记录',
    affectsSalary: false,
    notice: '仅查询后端已记录的同步任务，不创建新任务。',
  },
];

export const CARD_PROVIDER_OPTIONS = [
  { value: 'airwallex_card' as const, provider: 'airwallex', label: 'Airwallex 虚拟卡同步' },
  { value: 'photonpay_card' as const, provider: 'photonpay', label: 'PhotonPay 虚拟卡同步' },
];

export function statusText(status: string): string {
  const texts: Record<string, string> = {
    retry_wait: '等待重试',
    not_implemented: '未接入或未执行',
    pending: '待执行',
    running: '执行中',
    completed: '完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return texts[status] ?? status;
}

export function statusColor(status: string): string {
  if (status === 'not_implemented') return 'orange';
  if (status === 'completed') return 'green';
  if (status === 'running' || status === 'pending' || status === 'retry_wait') return 'blue';
  if (status === 'failed' || status === 'cancelled') return 'red';
  return 'default';
}

export function canExecuteStatus(status: string): boolean {
  return status !== 'running' && status !== 'completed' && status !== 'cancelled';
}

export function credentialText(summary?: CredentialSummary): string {
  if (!summary) return '凭证状态：请到 API 凭证配置页查看';
  if (!summary.hasCredential || summary.status === 'disabled') return '未配置凭证';
  return '已配置凭证';
}

export function sanitizeJson(value: unknown, seen = new WeakSet<object>()): SafeJsonNode {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return null;

  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, seen));

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSensitiveKey(key))
      .map(([key, nested]) => [key, sanitizeJson(nested, seen)] as const);
    return Object.fromEntries(entries);
  }

  return null;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.replace(/[\s-]/g, '').toLowerCase());
}

export function safeJsonText(value: unknown): string {
  return JSON.stringify(sanitizeJson(value), null, 2);
}

export function formatPayloadValue(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return safeJsonText(value);
}
