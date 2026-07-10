import { Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditWriteInput } from '../audit/audit.types';
import { AppError } from '../common/app-error';
import { Actor } from './base-data.types';

export type AuditInputArgs = {
  actor: Actor;
  action: string;
  objectType: string;
  objectId?: string;
  settlementMonth?: Date;
  beforeData?: unknown;
  afterData?: unknown;
  changedFields?: string[];
  requestPayload?: unknown;
};

export function auditInput(args: AuditInputArgs): Omit<AuditWriteInput, 'result'> {
  return {
    actorUserId: args.actor.userId,
    actorRole: args.actor.roleCode,
    action: args.action,
    objectType: args.objectType,
    objectId: args.objectId,
    settlementMonth: args.settlementMonth,
    beforeData: args.beforeData,
    afterData: args.afterData,
    changedFields: args.changedFields ?? [],
    requestPayload: args.requestPayload,
    ipAddress: args.actor.ipAddress,
    userAgent: args.actor.userAgent,
  };
}

export function assertStatus(value: unknown, allowed: readonly string[], field = 'status'): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

export function assertOptionalStatus<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field = 'status',
): T | undefined {
  if (value === undefined) return undefined;
  return assertStatus(value, allowed, field) as T;
}

export function assertDecimalEquals(
  actual: Prisma.Decimal,
  expected: Prisma.Decimal,
  field: string,
): void {
  if (!actual.equals(expected)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must equal ${expected.toString()}.`, {
      actual: actual.toString(),
      expected: expected.toString(),
    });
  }
}
