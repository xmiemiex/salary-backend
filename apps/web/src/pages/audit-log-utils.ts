import { hasPermission } from '../lib/permissions';
import type { Actor } from '../types/session';

export type AuditResult = 'success' | 'failure';

export type AuditModule =
  | 'auth'
  | 'admin_users'
  | 'roles'
  | 'sync_planning'
  | 'sync_execution'
  | 'sync_operations'
  | 'dashboard'
  | 'credentials'
  | 'system'
  | 'other';

export type AuditLogFilters = {
  createdFrom?: string;
  createdTo?: string;
  actorUserId?: string;
  actorUsername?: string;
  actorRole?: string;
  action?: string;
  objectType?: string;
  objectId?: string;
  result?: AuditResult;
  module?: AuditModule;
  settlementMonth?: string;
  requestId?: string;
  traceId?: string;
  ip?: string;
};

const FILTER_FIELDS: Array<keyof AuditLogFilters> = [
  'createdFrom',
  'createdTo',
  'actorUserId',
  'actorUsername',
  'actorRole',
  'action',
  'objectType',
  'objectId',
  'result',
  'module',
  'settlementMonth',
  'requestId',
  'traceId',
  'ip',
];

export function defaultAuditLogFilters(now = new Date()): AuditLogFilters {
  const to = new Date(now);
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { createdFrom: toDatetimeLocal(from), createdTo: toDatetimeLocal(to) };
}

export function toIsoWithTimezone(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function buildAuditLogsQuery(filters: AuditLogFilters, page: number, pageSize: number): string {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  appendFilters(params, filters);
  return params.toString();
}

export function buildAuditLogsExportQuery(filters: AuditLogFilters): string {
  const params = new URLSearchParams();
  appendFilters(params, filters);
  return params.toString();
}

export function validateAuditLogsRange(filters: AuditLogFilters): string | null {
  const fromText = filters.createdFrom?.trim();
  const toText = filters.createdTo?.trim();
  if (Boolean(fromText) !== Boolean(toText)) return '开始时间和结束时间必须同时填写。';
  if (!fromText || !toText) return null;
  const from = new Date(fromText);
  const to = new Date(toText);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return '请输入有效的时间范围。';
  if (from.getTime() > to.getTime()) return '开始时间不能晚于结束时间。';
  if (to.getTime() - from.getTime() > 90 * 24 * 60 * 60 * 1000) return '查询时间范围不能超过 90 天。';
  return null;
}

export function canExportAuditLogs(actor: Actor | null | undefined): boolean {
  return hasPermission(actor, 'audit_log.export');
}

export function fallbackAuditLogsFilename(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `audit-logs-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.csv`;
}

export function parseSafeAsciiFilename(contentDisposition: string | null | undefined): string | null {
  if (!contentDisposition || /[\r\n]/.test(contentDisposition)) return null;
  const match = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(contentDisposition);
  const filename = match?.[1] ?? match?.[2];
  if (!filename || filename.length > 160 || filename === '.' || filename === '..') return null;
  if (!/^[\x20-\x7E]+$/.test(filename) || /[<>:"/\\|?*]/.test(filename)) return null;
  return filename;
}

type BlobDownloadEnvironment = {
  document: Pick<Document, 'createElement' | 'body'>;
  url: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
  schedule: (callback: () => void) => unknown;
};

export function triggerBlobDownload(
  blob: Blob,
  filename: string,
  environment: BlobDownloadEnvironment = {
    document,
    url: URL,
    schedule: (callback) => window.setTimeout(callback, 0),
  },
): () => void {
  const objectUrl = environment.url.createObjectURL(blob);
  let revoked = false;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    environment.url.revokeObjectURL(objectUrl);
  };
  const anchor = environment.document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = 'none';
  environment.document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    environment.schedule(revoke);
  }
  return revoke;
}

export function auditResultTag(result: unknown): { text: string; color: string } {
  if (result === 'success') return { text: 'success', color: 'green' };
  if (result === 'failure') return { text: 'failure', color: 'red' };
  return { text: typeof result === 'string' && result ? result : '-', color: 'default' };
}

export function safeAuditJsonText(value: unknown): string {
  try {
    return JSON.stringify(redactClientFallback(value), null, 2);
  } catch {
    return '[无法展示]';
  }
}

export function moduleLabel(value: unknown): string {
  const labels: Record<string, string> = {
    auth: '认证',
    admin_users: '管理员',
    roles: '角色',
    sync_planning: '同步规划',
    sync_execution: '同步执行',
    sync_operations: '同步运行台',
    dashboard: '运营总览',
    credentials: '凭证',
    system: '系统',
    other: '其他',
  };
  return typeof value === 'string' ? labels[value] ?? value : '-';
}

export type LatestRequestGuard = ReturnType<typeof createLatestRequestGuard>;

export function createLatestRequestGuard() {
  let latestRequestId = 0;
  return {
    begin(): number {
      latestRequestId += 1;
      return latestRequestId;
    },
    invalidate(): void {
      latestRequestId += 1;
    },
    isCurrent(requestId: number): boolean {
      return requestId === latestRequestId;
    },
  };
}

type MountedRef = { current: boolean };

export function setupAuditLogRequestLifecycle(
  mounted: MountedRef,
  listGuard: LatestRequestGuard,
  detailGuard: LatestRequestGuard,
): () => void {
  mounted.current = true;
  return () => {
    mounted.current = false;
    listGuard.invalidate();
    detailGuard.invalidate();
  };
}

function appendFilters(params: URLSearchParams, filters: AuditLogFilters) {
  for (const key of FILTER_FIELDS) {
    const raw = filters[key];
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (!value) continue;
    if (key === 'createdFrom' || key === 'createdTo') {
      const iso = toIsoWithTimezone(String(value));
      if (iso) params.set(key, iso);
    } else {
      params.set(key, String(value));
    }
  }
}

function toDatetimeLocal(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function redactClientFallback(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactClientFallback);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child], index) => {
      const sensitiveKey = /password|token|secret|api[_-]?key|authorization|cookie|encrypted|credential|hash|bearer/i.test(key);
      return [
      sensitiveKey ? `redactedField${index + 1}` : key,
      sensitiveKey
        ? '[REDACTED]'
        : redactClientFallback(child),
      ];
    }));
  }
  if (typeof value === 'string') return value.replace(/\bBearer\s+[^\s,;]+/gi, '[REDACTED]').replace(/\b(token|apiKey|secret)=([^&\s,;]+)/gi, '[REDACTED]');
  return value;
}
