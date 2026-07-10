import { Prisma } from '@prisma/client';
import { sanitizeAuditText, sanitizeAuditValue } from '../audit/audit-sanitizer';

const FORBIDDEN_TEXT = [
  'password',
  'token',
  'apiKey',
  'secret',
  'bearer',
  'authorization',
  'encryptedPayload',
  'DATABASE_URL',
  'leaseOwner',
  'providerResponse',
  'rawResponse',
  'requestHeaders',
  'responseHeaders',
];

export function sanitizeAlertText(value: unknown, maxLength = 500): string {
  return removeForbiddenWords(sanitizeAuditText(value, maxLength));
}

export function sanitizeAlertDetails(value: unknown): Prisma.JsonValue | null {
  return stripForbiddenText(sanitizeAuditValue(value));
}

function stripForbiddenText(value: Prisma.JsonValue | null): Prisma.JsonValue | null {
  if (value === null) return null;
  if (typeof value === 'string') return removeForbiddenWords(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => stripForbiddenText(item)) as Prisma.JsonArray;
  return Object.fromEntries(
    Object.entries(value).map(([key, child], index) => {
      const unsafeKey = FORBIDDEN_TEXT.some((word) => key.toLowerCase().includes(word.toLowerCase()));
      return [unsafeKey ? `redactedField${index + 1}` : key, unsafeKey ? '[REDACTED]' : stripForbiddenText(child ?? null)];
    }),
  ) as Prisma.JsonObject;
}

function removeForbiddenWords(value: string): string {
  return FORBIDDEN_TEXT.reduce(
    (text, word) => text.replace(new RegExp(escapeRegExp(word), 'gi'), '[REDACTED]'),
    value,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
