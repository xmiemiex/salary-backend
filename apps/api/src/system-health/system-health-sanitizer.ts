import { sanitizeAuditText, sanitizeAuditValue } from '../audit/audit-sanitizer';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwordhash',
  'token',
  'tokenhash',
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
];

export function sanitizeSystemHealthValue<T>(value: T): T {
  return sanitizeValue(sanitizeAuditValue(value), 0) as T;
}

export function safeSystemHealthText(value: unknown, maxLength = 300): string {
  return sanitizeValue(sanitizeAuditText(value, maxLength), 0) as string;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return redactSensitiveTerms(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') {
    if (depth > 8) return '[TRUNCATED_DEPTH]';
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child], index) => {
      if (isSensitiveKey(key)) return [`redactedField${index + 1}`, REDACTED];
      return [key, sanitizeValue(child, depth + 1)];
    }));
  }
  return redactSensitiveTerms(String(value));
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function redactSensitiveTerms(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
    .replace(/\b(token|apiKey|apikey|clientSecret|secret|authorization|password)=([^&\s,;]+)/gi, REDACTED)
    .replace(/\b(DATABASE_URL)=([^&\s,;]+)/gi, REDACTED)
    .slice(0, 1000);
}
