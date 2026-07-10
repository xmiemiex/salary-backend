import { Injectable } from '@nestjs/common';
import { AlertSeverity, Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { sanitizeAlertDetails, sanitizeAlertText } from './alert-sanitizer';

type Client = PrismaService | Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(actor: Actor, query: Record<string, unknown> = {}) {
    const page = positiveInt(query.page, 1, 100000);
    const pageSize = positiveInt(query.pageSize, 20, 100);
    const unreadOnly = query.unreadOnly === 'true';
    const where: Prisma.NotificationWhereInput = {
      recipientId: actor.userId,
      readAt: unreadOnly ? null : undefined,
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, items: items.map(notificationDto) };
  }

  async unreadCount(actor: Actor) {
    const count = await this.prisma.notification.count({ where: { recipientId: actor.userId, readAt: null } });
    return { count };
  }

  async markRead(idInput: string, actor: Actor) {
    const id = uuid(idInput);
    const now = new Date();
    const updated = await this.prisma.notification.updateMany({
      where: { id, recipientId: actor.userId, readAt: null },
      data: { readAt: now },
    });
    const item = await this.prisma.notification.findFirst({ where: { id, recipientId: actor.userId } });
    if (!item) throw new AppError(ERROR_CODES.NOT_FOUND, 'Notification not found.');
    if (updated.count > 0) {
      await this.audit.success({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'notification.read',
        objectType: 'notification',
        objectId: id,
        requestPayload: { notificationId: id, count: updated.count, timestamp: now.toISOString() },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
    }
    return notificationDto(item.readAt ? item : { ...item, readAt: now });
  }

  async markAllRead(actor: Actor) {
    const now = new Date();
    const updated = await this.prisma.notification.updateMany({
      where: { recipientId: actor.userId, readAt: null },
      data: { readAt: now },
    });
    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'notification.read_all',
      objectType: 'notification',
      requestPayload: { count: updated.count, timestamp: now.toISOString() },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return { count: updated.count, readAt: now.toISOString() };
  }

  async notifySuperAdmins(input: {
    alertId: string;
    type: string;
    severity: AlertSeverity;
    title: string;
    safeMessage: string;
    safeDetails?: unknown;
  }, prisma: Client = this.prisma) {
    const recipients = await prisma.adminUser.findMany({
      where: {
        status: 'active',
        roles: {
          some: {
            role: {
              status: 'active',
              OR: [
                { code: 'super_admin' },
                { permissions: { some: { permission: { code: 'alerts.read' } } } },
              ],
            },
          },
        },
      },
      select: { id: true },
    });
    let created = 0;
    for (const recipient of recipients) {
      const existing = await prisma.notification.findFirst({
        where: { recipientId: recipient.id, alertId: input.alertId, type: input.type, readAt: null },
        select: { id: true },
      });
      if (existing) continue;
      try {
        await prisma.notification.create({
          data: {
            recipientId: recipient.id,
            alertId: input.alertId,
            type: input.type,
            severity: input.severity,
            title: sanitizeAlertText(input.title, 255),
            safeMessage: sanitizeAlertText(input.safeMessage, 1000),
            safeDetails: jsonInput(input.safeDetails),
          },
        });
        created += 1;
      } catch (error) {
        if (!isUniqueConflict(error)) throw error;
      }
    }
    return created;
  }
}

function notificationDto(item: {
  id: string;
  recipientId: string;
  alertId: string | null;
  type: string;
  severity: AlertSeverity;
  title: string;
  safeMessage: string;
  safeDetails: Prisma.JsonValue | null;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: item.id,
    alertId: item.alertId,
    type: item.type,
    severity: item.severity,
    title: sanitizeAlertText(item.title, 255),
    safeMessage: sanitizeAlertText(item.safeMessage, 1000),
    safeDetails: sanitizeAlertDetails(item.safeDetails),
    readAt: item.readAt,
    createdAt: item.createdAt,
  };
}

function uuid(value: unknown) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'id must be a valid UUID.');
  return value;
}

function positiveInt(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'pagination must be a positive integer.');
  const parsed = Number(value);
  if (parsed < 1 || parsed > max) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'pagination is out of range.');
  return parsed;
}

function jsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  const sanitized = sanitizeAlertDetails(value);
  return sanitized === null ? undefined : sanitized;
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
