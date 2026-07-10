import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { CommonStatus } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { Reflector } from '@nestjs/core';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { Actor, RequestWithActor } from './auth.types';
import { IS_PUBLIC_KEY } from './public.decorator';
import { hashSessionToken } from './auth.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) return true;

    const request = context.switchToHttp().getRequest<RequestWithActor>();
    const token = this.extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Authorization bearer token is required.');
    }

    const session = await this.prisma.adminSession.findFirst({
      where: { tokenHash: hashSessionToken(token), revokedAt: null, expiresAt: { gt: new Date() } },
      include: {
        adminUser: { include: { roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: { permission: true },
                },
              },
            },
          },
        } } },
      },
    });

    if (!session) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Invalid authorization token.');
    }
    const user = session.adminUser;
    if (user.status !== CommonStatus.active) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Invalid authorization token.');
    }

    const activeRoles = user.roles.map((userRole) => userRole.role).filter((role) => role.status === CommonStatus.active);
    if (activeRoles.length === 0) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Invalid authorization token.');
    }

    const permissions = Array.from(
      new Set(activeRoles.flatMap((role) => role.permissions.map((rolePermission) => rolePermission.permission.code))),
    ).sort();

    const actor: Actor = {
      userId: user.id,
      roleCode: activeRoles[0].code,
      permissions,
      employeeId: user.employeeId ?? undefined,
      ipAddress: this.firstHeader(request.headers['x-forwarded-for']) ?? request.ip,
      userAgent: this.firstHeader(request.headers['user-agent']),
    };

    request.user = actor;
    request.actor = actor;
    request.authSessionId = session.id;
    const lastUsedCutoff = new Date(Date.now() - 5 * 60 * 1000);
    if (!session.lastUsedAt || session.lastUsedAt < lastUsedCutoff) {
      void this.prisma.adminSession.updateMany({
        where: { id: session.id, revokedAt: null, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: lastUsedCutoff } }] },
        data: { lastUsedAt: new Date() },
      }).catch(() => undefined);
    }
    return true;
  }

  private isPublic(context: ExecutionContext): boolean {
    return this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]) === true;
  }

  private extractBearerToken(value: string | string[] | undefined): string | undefined {
    const authorization = this.firstHeader(value);
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || undefined;
  }

  private firstHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
