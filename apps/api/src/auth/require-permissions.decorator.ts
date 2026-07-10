import { SetMetadata } from '@nestjs/common';
import { PermissionCode } from '@salary/shared';

export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const REQUIRED_ANY_PERMISSIONS_KEY = 'requiredAnyPermissions';

export const RequirePermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

export const RequireAnyPermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(REQUIRED_ANY_PERMISSIONS_KEY, permissions);
