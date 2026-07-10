import { CommonStatus } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuthService, hashSessionToken } from './auth.service';
import { PasswordHashService } from './password-hash.service';

describe('AuthService', () => {
  const password = 'correct-horse-42';
  let passwordHash: string;

  beforeAll(async () => { passwordHash = await new PasswordHashService().hash(password); });

  function setup(userOverride: Record<string, unknown> | null = {}, sessionOverride: Record<string, unknown> | null = null) {
    const user = userOverride === null ? null : {
      id: 'user-1', username: 'admin', passwordHash, status: CommonStatus.active, employeeId: null,
      roles: [{ role: { code: 'super_admin', status: CommonStatus.active, permissions: [{ permission: { code: 'user.manage' } }] } }],
      ...userOverride,
    };
    const created: Array<Record<string, unknown>> = [];
    const auditWrites: Array<Record<string, unknown>> = [];
    const tx = {
      adminSession: { create: jest.fn(async ({ data }) => { created.push(data); return { id: 'session-1', ...data }; }), updateMany: jest.fn() },
      adminUser: { update: jest.fn() }, auditLog: { create: jest.fn(async ({ data }) => { auditWrites.push(data); return data; }) },
    };
    const prisma = {
      adminUser: { findUnique: jest.fn().mockResolvedValue(user) },
      adminSession: { findUnique: jest.fn().mockResolvedValue(sessionOverride) },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };
    const audit = {
      success: jest.fn(async (input) => { auditWrites.push(input); }),
      failure: jest.fn(async (input) => { auditWrites.push(input); }),
    };
    const service = new AuthService(prisma as never, new PasswordHashService(), { sessionTtlHours: 12 } as never, audit as never);
    return { service, created, auditWrites, audit, tx };
  }

  it('returns a random token and stores only its SHA-256 hash', async () => {
    const { service, created, auditWrites } = setup();
    const first = await service.login({ username: 'admin', password }, { ipAddress: '127.0.0.1' });
    const second = await setup().service.login({ username: 'admin', password }, {});
    expect(Buffer.from(first.token, 'base64url')).toHaveLength(32);
    expect(first.token).not.toBe(second.token);
    expect(created[0]).toMatchObject({ tokenHash: hashSessionToken(first.token), adminUserId: 'user-1' });
    expect(JSON.stringify(created)).not.toContain(first.token);
    expect(JSON.stringify(auditWrites)).not.toContain(password);
    expect(JSON.stringify(auditWrites)).not.toContain(first.token);
  });

  it('uses the same generic response for missing users and wrong passwords', async () => {
    const errors = [];
    for (const service of [setup(null).service, setup().service]) {
      try { await service.login({ username: 'admin', password: 'wrong-password-99' }, {}); } catch (error) { errors.push(error); }
    }
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(error).toMatchObject({ code: ERROR_CODES.UNAUTHORIZED, message: 'Invalid username or password.' });
  });

  it('rejects disabled users and users without an active role', async () => {
    for (const override of [{ status: CommonStatus.disabled }, { roles: [] }]) {
      await expect(setup(override).service.login({ username: 'admin', password }, {})).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });
    }
  });

  it('builds a new login actor only from the replacement role permissions', async () => {
    const roles = [{ role: { code: 'finance', status: CommonStatus.active, permissions: [{ permission: { code: 'income.import' } }] } }];
    const result = await setup({ roles }).service.login({ username: 'admin', password }, {});
    expect(result.actor).toMatchObject({ roleCode: 'finance', permissions: ['income.import'] });
    expect(result.actor.permissions).not.toContain('user.manage');
  });

  it('revokes only the current session on logout', async () => {
    const { service, tx } = setup();
    await service.logout('session-1', { userId: 'user-1', roleCode: 'admin', permissions: [] });
    expect(tx.adminSession.updateMany).toHaveBeenCalledWith({ where: { id: 'session-1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });

  it('rejects revoking another administrator active session', async () => {
    const { service, audit, tx } = setup({}, {
      adminUserId: 'user-2',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(service.revokeSession('10000000-0000-4000-8000-000000000001', 'session-1', {
      userId: 'user-1',
      roleCode: 'admin',
      permissions: [],
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(audit.failure).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.session_revoke_denied' }));
    expect(tx.adminSession.updateMany).not.toHaveBeenCalled();
  });
});
