import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES, PermissionCode } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { Actor, RequestWithActor } from './auth.types';
import { REQUIRED_ANY_PERMISSIONS_KEY, REQUIRED_PERMISSIONS_KEY } from './require-permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions =
      this.reflector.getAllAndOverride<PermissionCode[]>(REQUIRED_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const requiredAnyPermissions =
      this.reflector.getAllAndOverride<PermissionCode[]>(REQUIRED_ANY_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (requiredPermissions.length === 0 && requiredAnyPermissions.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithActor>();
    const actor = request.actor ?? request.user;
    const granted = new Set(actor?.permissions ?? []);
    const missingPermissions = requiredPermissions.filter((permission) => !granted.has(permission));
    const hasAnyPermission =
      requiredAnyPermissions.length === 0 || requiredAnyPermissions.some((permission) => granted.has(permission));
    if (missingPermissions.length === 0 && hasAnyPermission) return true;

    const missingAnyPermissions = hasAnyPermission ? [] : requiredAnyPermissions;

    await this.writePermissionDeniedAudit(actor, request, requiredPermissions, missingPermissions, requiredAnyPermissions, missingAnyPermissions);
    const details = {
      requiredPermissions,
      missingPermissions,
      ...(requiredAnyPermissions.length > 0 ? { requiredAnyPermissions, missingAnyPermissions } : {}),
    };
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'Permission denied.', details);
  }

  private async writePermissionDeniedAudit(
    actor: Actor | undefined,
    request: RequestWithActor,
    requiredPermissions: PermissionCode[],
    missingPermissions: PermissionCode[],
    requiredAnyPermissions: PermissionCode[],
    missingAnyPermissions: PermissionCode[],
  ) {
    await this.audit.failure({
      actorUserId: actor?.userId,
      actorRole: actor?.roleCode,
      action: 'permission.denied',
      objectType: 'route',
      requestPayload: {
        method: request.method,
        path: request.originalUrl ?? request.url,
        requiredPermissions,
        missingPermissions,
        requiredAnyPermissions,
        missingAnyPermissions,
      },
      failureReason: ERROR_CODES.PERMISSION_DENIED,
      errorMessage: `Missing permissions: ${[...missingPermissions, ...missingAnyPermissions].join(', ')}`,
      ipAddress: actor?.ipAddress,
      userAgent: actor?.userAgent,
    });
  }
}
