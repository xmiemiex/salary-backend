import type { Actor } from '../types/session';

export const SENSITIVE_FIELD_PATTERN = /passwordHash|tokenHash|(^|_)token|apiKey|secret|clientId|merchantId|encryptedPayload|authorization|DATABASE_URL|rawPayload/i;

export function currentGmt8Month(now = new Date()): string {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function formatDashboardMoney(value: string | null | undefined, currency: 'USD' | 'RMB' = 'USD'): string {
  if (value === null || value === undefined || !/^-?\d+(?:\.\d+)?$/.test(value)) return '—';
  const [integer, fraction = ''] = value.split('.');
  const normalized = `${Number(integer).toLocaleString('zh-CN')}.${`${fraction}00`.slice(0, 2)}`;
  return `${currency === 'USD' ? '$' : '¥'}${normalized}`;
}

export function formatDashboardTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}

export function canNavigateDashboardTarget(actor: Actor, path: string): boolean {
  const permissions: Record<string, string[]> = {
    '/data-sync': ['salary.view_all', 'income.import', 'manual_card_spend.manage'],
    '/sync-reconciliation': ['salary.view_all'],
    '/sync-unmatched-events': ['salary.view_all', 'settlement.generate'],
    '/monthly-exchange-rates': ['monthly_exchange_rate.manage'],
    '/card-provider-fee-rates': ['card_provider_fee_rate.manage'],
    '/salary-settlements': ['salary.view_all', 'settlement.generate', 'settlement.lock', 'salary.export'],
  };
  return (permissions[path] ?? []).some((permission) => actor.permissions.includes(permission));
}

export function containsSensitiveDashboardField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSensitiveDashboardField);
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => SENSITIVE_FIELD_PATTERN.test(key) || containsSensitiveDashboardField(nested));
}
