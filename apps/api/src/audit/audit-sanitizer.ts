import { Prisma } from '@prisma/client';

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

const REDACTED = '[REDACTED]';
const MAX_STRING_LENGTH = 1_000;
const MAX_SUMMARY_LENGTH = 300;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 8;

const SENSITIVE_KEY_PARTS = [
  'password',
  'passwordhash',
  'oldpassword',
  'newpassword',
  'token',
  'tokenhash',
  'refreshtoken',
  'sessiontoken',
  'apikey',
  'secret',
  'clientsecret',
  'merchantid',
  'authorization',
  'bearer',
  'encryptedpayload',
  'credentialpayload',
  'databaseurl',
  'cookie',
  'setcookie',
  'providerresponse',
  'rawresponse',
  'requestheaders',
  'responseheaders',
  'leaseowner',
  'fullthirdpartyresponse',
  'cardnumber',
];

const SENSITIVE_STRING_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(token|apiKey|apikey|clientSecret|secret|authorization|password)=([^&\s,;]+)/gi,
  /\b(DATABASE_URL)=([^&\s,;]+)/gi,
];

export function sanitizeAuditValue(value: unknown, depth = 0): Prisma.JsonValue | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (depth >= MAX_DEPTH) return '[TRUNCATED_DEPTH]';

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeAuditValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[TRUNCATED_${value.length - MAX_ARRAY_ITEMS}_ITEMS]`);
    return items as Prisma.JsonArray;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS).map(([key, child], index) => {
      const sensitiveKey = isSensitiveKey(key);
      return [
        sensitiveKey ? `redactedField${index + 1}` : key,
        sensitiveKey ? REDACTED : sanitizeAuditValue(child, depth + 1),
      ];
    });
    if (Object.keys(value as Record<string, unknown>).length > MAX_OBJECT_KEYS) {
      entries.push(['__truncatedKeys', '[TRUNCATED_KEYS]']);
    }
    return Object.fromEntries(entries) as Prisma.JsonObject;
  }

  return sanitizeString(String(value));
}

export function sanitizeAuditText(value: unknown, maxLength = MAX_STRING_LENGTH): string {
  return truncate(sanitizeString(String(value ?? '')), maxLength);
}

export function summarizeAuditValue(value: unknown): string {
  const sanitized = sanitizeAuditValue(value);
  if (sanitized === null) return '';
  if (typeof sanitized === 'string') return truncate(sanitized, MAX_SUMMARY_LENGTH);
  return truncate(JSON.stringify(sanitized), MAX_SUMMARY_LENGTH);
}

export function toUserAgentSummary(value: unknown): string {
  const text = sanitizeAuditText(value, 180);
  if (!text) return '';
  return text.replace(/\s+/g, ' ');
}

export function deriveAuditModule(actionInput: unknown, objectTypeInput: unknown): AuditModule {
  const action = String(actionInput ?? '').toLowerCase();
  const objectType = String(objectTypeInput ?? '').toLowerCase();
  if (action.startsWith('auth.')) return 'auth';
  if (action.startsWith('admin_user.') || objectType === 'admin_users' || objectType === 'admin_user') return 'admin_users';
  if (action.startsWith('role.') || objectType === 'roles' || objectType === 'role') return 'roles';
  if (action.includes('sync_planning')) return 'sync_planning';
  if (action.includes('sync_execution') || action.includes('auto_execution')) return 'sync_execution';
  if (action.includes('sync_task.manual_retry_requested') || action.includes('sync_task.cancelled')) return 'sync_operations';
  if (action.includes('credential') || objectType.includes('credential')) return 'credentials';
  if (action.includes('dashboard') || objectType.includes('dashboard')) return 'dashboard';
  if (!action && !objectType) return 'other';
  return 'system';
}

export function csvSafeCell(value: unknown): string {
  let text = value === null || value === undefined ? ''
    : value instanceof Date ? value.toISOString()
    : Array.isArray(value) ? value.map((item) => sanitizeAuditText(item, 120)).join(' | ')
    : sanitizeAuditText(value, MAX_STRING_LENGTH);
  if (/^\s*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function sanitizeString(value: string): string {
  let text = truncate(value, MAX_STRING_LENGTH);
  for (const pattern of SENSITIVE_STRING_PATTERNS) {
    text = text.replace(pattern, REDACTED);
  }
  return text;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...[TRUNCATED]` : value;
}
