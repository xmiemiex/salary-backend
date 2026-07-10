import { Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../common/app-error';
import { Actor } from './base-data.types';

export function actorFromHeaders(headers: Record<string, string | string[] | undefined>): Actor {
  return {
    userId: headerValue(headers, 'x-actor-user-id') ?? '00000000-0000-0000-0000-000000000000',
    roleCode: headerValue(headers, 'x-actor-role') ?? 'system',
    ipAddress: headerValue(headers, 'x-forwarded-for'),
    userAgent: headerValue(headers, 'user-agent'),
  };
}

export function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is required.`);
  }
  return value.trim();
}

export function optionalNonBlank(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireNonBlank(value, field);
}

export function parseOptionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parseDate(value, field);
}

export function parseMonthStart(value: unknown, field: string): Date {
  const date = parseDate(value, field);
  if (
    date.getUTCDate() !== 1 ||
    date.getUTCHours() !== 0 ||
    date.getUTCMinutes() !== 0 ||
    date.getUTCSeconds() !== 0 ||
    date.getUTCMilliseconds() !== 0
  ) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be the first day of the month.`);
  }
  return date;
}

export function parseDecimalString(value: unknown, field: string, options: { gtZero?: boolean } = {}): Prisma.Decimal {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a decimal string.`);
  }

  let decimal: Prisma.Decimal;
  try {
    decimal = new Prisma.Decimal(value.trim());
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a valid decimal string.`);
  }

  if (!decimal.isFinite() || (options.gtZero ? decimal.lte(0) : decimal.lt(0))) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `${field} must be ${options.gtZero ? 'greater than 0' : 'greater than or equal to 0'}.`,
    );
  }

  return decimal;
}

export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

export function isDuplicateError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function duplicateResource(message: string): AppError {
  return new AppError(ERROR_CODES.DUPLICATE_RESOURCE, message);
}

export function notFound(objectType: string): AppError {
  return new AppError(ERROR_CODES.NOT_FOUND, `${objectType} not found.`);
}

export function formatMonth(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDate(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a valid date.`);
    }
    return value;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a date string.`);
  }

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T00:00:00.000Z` : value.trim();
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a valid date.`);
  }
  return date;
}

function headerValue(headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = headers[key] ?? headers[key.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
