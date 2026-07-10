import { Prisma } from '@prisma/client';

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 80;
const MAX_STRING_LENGTH = 1_000;

const SENSITIVE_KEY_PARTS = [
  'password',
  'passwordhash',
  'token',
  'tokenhash',
  'apikey',
  'secret',
  'bearer',
  'authorization',
  'databaseurl',
  'encryptedpayload',
  'credentialpayload',
  'leaseowner',
  'providerresponse',
  'rawresponse',
  'requestheaders',
  'responseheaders',
];

const SENSITIVE_TEXT = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(password|token|apiKey|apikey|secret|authorization|DATABASE_URL)=([^&\s,;]+)/gi,
  /(?:file|s3):\/\/[^\s"'<>]+/gi,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@[^\s"'<>]+/gi,
];

export function sanitizeReleaseGateValue(value: unknown, depth = 0): Prisma.JsonValue | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return sanitizeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[TRUNCATED_DEPTH]';

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeReleaseGateValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[TRUNCATED_${value.length - MAX_ARRAY_ITEMS}_ITEMS]`);
    return items as Prisma.JsonArray;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS).map(([key, child], index) => {
      if (isSensitiveKey(key)) return [`redactedField${index + 1}`, REDACTED];
      return [key, sanitizeReleaseGateValue(child, depth + 1)];
    });
    return Object.fromEntries(entries) as Prisma.JsonObject;
  }

  return sanitizeText(String(value));
}

export function sanitizeReleaseGateText(value: unknown, maxLength = MAX_STRING_LENGTH): string {
  return truncate(sanitizeText(String(value ?? '')), maxLength);
}

export function containsSensitiveReleaseGateField(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /\b(password|passwordHash|token|tokenHash|apiKey|secret|bearer|authorization|DATABASE_URL|encryptedPayload|credentialPayload|leaseOwner|providerResponse|rawResponse|requestHeaders|responseHeaders)\b/i.test(text)
    || /(?:file|s3):\/\//i.test(text)
    || /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(text);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function sanitizeText(value: string): string {
  let text = truncate(value, MAX_STRING_LENGTH);
  for (const pattern of SENSITIVE_TEXT) text = text.replace(pattern, REDACTED);
  return text;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...[TRUNCATED]` : value;
}
