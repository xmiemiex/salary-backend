import { ExecutionContext } from '@nestjs/common';
import { CommonStatus } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuthGuard } from './auth.guard';
import { hashSessionToken } from './auth.service';

describe('AuthGuard', () => {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };

  function makeContext(token?: string) {
    const request = { headers: token ? { authorization: `Bearer ${token}`, 'user-agent': 'jest' } : {}, ip: '127.0.0.1' };
    return {
      request,
      context: {
        getHandler: jest.fn(), getClass: jest.fn(),
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  }

  function makeGuard(session: unknown) {
    const prisma = {
      adminSession: {
        findFirst: jest.fn().mockResolvedValue(session),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return { guard: new AuthGuard(prisma as never, reflector as never), prisma };
  }

  const activeSession = {
    id: 'session-1', lastUsedAt: new Date(),
    adminUser: {
      id: 'user-1', status: CommonStatus.active, employeeId: 'employee-1',
      roles: [{ role: { code: 'finance', status: CommonStatus.active, permissions: [{ permission: { code: 'income.import' } }] } }],
    },
  };

  it('requires a bearer token', async () => {
    await expect(makeGuard(null).guard.canActivate(makeContext().context)).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('queries by SHA-256 token hash, not admin user id', async () => {
    const { guard, prisma } = makeGuard(null);
    await expect(guard.canActivate(makeContext('user-uuid').context)).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });
    expect(prisma.adminSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tokenHash: hashSessionToken('user-uuid'), revokedAt: null, expiresAt: expect.any(Object) }),
    }));
  });

  it.each([
    ['expired', null],
    ['revoked', null],
  ])('rejects a %s session uniformly', async (_name, session) => {
    await expect(makeGuard(session).guard.canActivate(makeContext('token').context)).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('returns UNAUTHORIZED for an old token after password update revoked its session', async () => {
    const { guard, prisma } = makeGuard(null);
    await expect(guard.canActivate(makeContext('old-session-token').context)).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });
    expect(prisma.adminSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ revokedAt: null }),
    }));
  });

  it('rejects disabled users and users without active roles', async () => {
    for (const user of [
      { ...activeSession.adminUser, status: CommonStatus.disabled },
      { ...activeSession.adminUser, roles: [] },
    ]) {
      await expect(makeGuard({ ...activeSession, adminUser: user }).guard.canActivate(makeContext('token').context)).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });
    }
  });

  it('hydrates the actor and current session id', async () => {
    const { request, context } = makeContext('opaque-token');
    await expect(makeGuard(activeSession).guard.canActivate(context)).resolves.toBe(true);
    expect(request).toMatchObject({
      authSessionId: 'session-1',
      actor: { userId: 'user-1', roleCode: 'finance', permissions: ['income.import'], employeeId: 'employee-1' },
    });
  });
});
