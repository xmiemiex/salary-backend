import { ExecutionContext } from '@nestjs/common';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../common/app-error';
import { PermissionsGuard } from './permissions.guard';
import { REQUIRED_ANY_PERMISSIONS_KEY, REQUIRED_PERMISSIONS_KEY } from './require-permissions.decorator';

describe('PermissionsGuard', () => {
  function context(actorPermissions: string[]): ExecutionContext {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({
          actor: {
            userId: 'user-1',
            roleCode: 'finance',
            permissions: actorPermissions,
            ipAddress: '127.0.0.1',
            userAgent: 'jest',
          },
          method: 'POST',
          originalUrl: '/employees',
          headers: {},
        }),
      }),
    } as unknown as ExecutionContext;
  }

  function guard(requiredPermissions: string[], requiredAnyPermissions: string[] = []) {
    const audit = { failure: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === REQUIRED_PERMISSIONS_KEY) return requiredPermissions;
        if (key === REQUIRED_ANY_PERMISSIONS_KEY) return requiredAnyPermissions;
        return [];
      }),
    };
    return { permissionsGuard: new PermissionsGuard(reflector as never, audit as never), audit };
  }

  it('passes when actor has all required permissions', async () => {
    const { permissionsGuard, audit } = guard(['employee.manage']);

    await expect(permissionsGuard.canActivate(context(['employee.manage']))).resolves.toBe(true);
    expect(audit.failure).not.toHaveBeenCalled();
  });

  it('throws PERMISSION_DENIED and writes failure audit when permission is missing', async () => {
    const { permissionsGuard, audit } = guard(['employee.manage']);

    await expect(permissionsGuard.canActivate(context(['salary.view_all']))).rejects.toMatchObject({
      code: ERROR_CODES.PERMISSION_DENIED,
    });
    expect(audit.failure).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        actorRole: 'finance',
        action: 'permission.denied',
        objectType: 'route',
        failureReason: ERROR_CODES.PERMISSION_DENIED,
        requestPayload: expect.objectContaining({
          method: 'POST',
          path: '/employees',
          requiredPermissions: ['employee.manage'],
          missingPermissions: ['employee.manage'],
        }),
      }),
    );
  });

  it('passes when actor has one of the any permissions', async () => {
    const { permissionsGuard, audit } = guard([], ['salary.view_all', 'income.import']);

    await expect(permissionsGuard.canActivate(context(['income.import']))).resolves.toBe(true);
    expect(audit.failure).not.toHaveBeenCalled();
  });

  it('throws PERMISSION_DENIED when actor has none of the any permissions', async () => {
    const { permissionsGuard, audit } = guard([], ['salary.view_all', 'income.import']);

    await expect(permissionsGuard.canActivate(context(['manual_card_spend.manage']))).rejects.toMatchObject({
      code: ERROR_CODES.PERMISSION_DENIED,
    });
    expect(audit.failure).toHaveBeenCalledWith(
      expect.objectContaining({
        requestPayload: expect.objectContaining({
          requiredAnyPermissions: ['salary.view_all', 'income.import'],
          missingAnyPermissions: ['salary.view_all', 'income.import'],
        }),
      }),
    );
  });
});
