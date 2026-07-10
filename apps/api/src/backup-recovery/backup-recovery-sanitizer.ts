import { Prisma } from '@prisma/client';
import { AppError } from '../common/app-error';
import { ERROR_CODES } from '@salary/shared';
import { sanitizeAuditText, sanitizeAuditValue } from '../audit/audit-sanitizer';

const FORBIDDEN_KEY = /password|token|apiKey|apikey|secret|bearer|authorization|database_url|databaseurl|encryptedPayload|credentialPayload|providerResponse|rawResponse/i;
const FORBIDDEN_TEXT = /(?:file|s3|gs|https?):\/\/|[A-Za-z]:\\|\/var\/backups\/|\b(?:password|token|apiKey|apikey|secret|bearer|authorization|DATABASE_URL|credentialPayload|encryptedPayload)\b/i;
const SAFE_ALIAS = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256 = /^[a-f0-9]{64}$/i;

export function safeAlias(value: unknown, field: string, required = true): string | null {
  if (value === undefined || value === null || value === '') {
    if (!required) return null;
    throw invalid(`${field} is required.`);
  }
  if (typeof value !== 'string' || !SAFE_ALIAS.test(value) || FORBIDDEN_TEXT.test(value)) {
    throw invalid(`${field} must be a safe alias.`);
  }
  return value;
}

export function safeRecordKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_KEY.test(value) || FORBIDDEN_TEXT.test(value)) {
    throw invalid(`${field} must be a safe key.`);
  }
  return value;
}

export function safeChecksum(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !SHA256.test(value)) throw invalid('checksumSha256 must be a SHA-256 hex digest.');
  return value.toLowerCase();
}

export function safeOptionalText(value: unknown, field: string, maxLength = 1000): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > maxLength || FORBIDDEN_TEXT.test(value)) {
    throw invalid(`${field} contains unsafe text.`);
  }
  return sanitizeAuditText(value, maxLength);
}

export function safeJson(value: unknown, field: string): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'string' ? parseJson(value, field) : value;
  assertSafeJson(parsed, field);
  const sanitized = sanitizeAuditValue(parsed);
  return sanitized === null ? undefined : sanitized;
}

export function publicJson(value: unknown): Prisma.JsonValue | null {
  return sanitizeAuditValue(value);
}

export function hasUnsafeRuntimeText(value: unknown): boolean {
  return FORBIDDEN_TEXT.test(JSON.stringify(value)) || FORBIDDEN_KEY.test(JSON.stringify(value));
}

function parseJson(value: string, field: string) {
  try {
    return JSON.parse(value);
  } catch {
    throw invalid(`${field} must be valid JSON.`);
  }
}

function assertSafeJson(value: unknown, path: string, depth = 0) {
  if (depth > 8) throw invalid(`${path} is too deeply nested.`);
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (FORBIDDEN_TEXT.test(value)) throw invalid(`${path} contains unsafe text.`);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    if (value.length > 100) throw invalid(`${path} has too many items.`);
    value.forEach((item, index) => assertSafeJson(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 100) throw invalid(`${path} has too many keys.`);
    for (const [key, child] of entries) {
      if (FORBIDDEN_KEY.test(key) || FORBIDDEN_TEXT.test(key)) throw invalid(`${path} contains unsafe key.`);
      assertSafeJson(child, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw invalid(`${path} contains unsupported value.`);
}

function invalid(message: string) {
  return new AppError(ERROR_CODES.VALIDATION_ERROR, message);
}
