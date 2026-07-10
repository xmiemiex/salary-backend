import { Injectable, Logger } from '@nestjs/common';
import { AuditResult, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { sanitizeAuditText, sanitizeAuditValue } from './audit-sanitizer';
import { AuditWriteInput } from './audit.types';

type AuditPrismaClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async write(input: AuditWriteInput, prisma: AuditPrismaClient = this.prisma) {
    try {
      return await prisma.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          action: input.action,
          objectType: input.objectType,
          objectId: input.objectId,
          settlementMonth: input.settlementMonth,
          beforeData: jsonInput(input.beforeData),
          afterData: jsonInput(input.afterData),
          changedFields: (input.changedFields ?? []).map((field, index) => sanitizeAuditText(field, 120).match(/password|token|secret|api[_-]?key|authorization|cookie|encrypted|credential|hash|bearer/i) ? `redactedField${index + 1}` : sanitizeAuditText(field, 120)),
          requestPayload: jsonInput(input.requestPayload),
          result: input.result,
          failureReason: input.failureReason ? sanitizeAuditText(input.failureReason) : input.failureReason,
          errorMessage: input.errorMessage ? sanitizeAuditText(input.errorMessage) : input.errorMessage,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent ? sanitizeAuditText(input.userAgent, 500) : input.userAgent,
        },
      });
    } catch (error) {
      this.logger.error('Failed to write audit log', error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  async success(input: Omit<AuditWriteInput, 'result'>, prisma?: AuditPrismaClient) {
    return this.write({ ...input, result: AuditResult.success }, prisma);
  }

  async failure(input: Omit<AuditWriteInput, 'result'>, prisma?: AuditPrismaClient) {
    return this.write({ ...input, result: AuditResult.failure }, prisma);
  }
}

function jsonInput(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (value === undefined) return undefined;
  return sanitizeAuditValue(value) ?? Prisma.JsonNull;
}
