import { CommonStatus } from '@prisma/client';
import {
  formatAdminProvisionResult,
  provisionAdmin,
  redactCliError,
  type AdminProvisionInput,
} from './admin-provisioning';

describe('admin provisioning', () => {
  const input: AdminProvisionInput = {
    username: 'admin', email: 'admin@example.com', password: 'correct-horse-42', roleCode: 'finance', updateMode: true,
  };

  function setup(options: {
    existingUser?: { id: string; username: string } | null;
    emailUser?: { id: string } | null;
    role?: { id: string; status: CommonStatus } | null;
  } = {}) {
    const existingUser = options.existingUser === undefined ? { id: 'user-1', username: 'admin' } : options.existingUser;
    const tx = {
      role: { findUnique: jest.fn().mockResolvedValue(options.role === undefined ? { id: 'role-finance', status: CommonStatus.active } : options.role) },
      adminUser: {
        findUnique: jest.fn()
          .mockResolvedValueOnce(existingUser)
          .mockResolvedValueOnce(options.emailUser === undefined ? existingUser : options.emailUser),
        update: jest.fn().mockResolvedValue(existingUser),
        create: jest.fn().mockResolvedValue({ id: 'new-user', username: 'admin' }),
      },
      adminUserRole: { deleteMany: jest.fn(), upsert: jest.fn() },
      adminSession: { updateMany: jest.fn() },
    };
    const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };
    const hashes = { hash: jest.fn().mockResolvedValue('scrypt-hash') };
    return { prisma, tx, hashes };
  }

  it('atomically replaces roles and revokes only current active sessions on update', async () => {
    const { prisma, tx, hashes } = setup();
    await expect(provisionAdmin(prisma as never, hashes as never, input)).resolves.toEqual({ id: 'user-1', username: 'admin', updated: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.adminUser.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user-1' }, data: expect.objectContaining({ passwordHash: 'scrypt-hash' }) }));
    expect(tx.adminUserRole.deleteMany).toHaveBeenCalledWith({ where: { adminUserId: 'user-1', roleId: { not: 'role-finance' } } });
    expect(tx.adminUserRole.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { adminUserId_roleId: { adminUserId: 'user-1', roleId: 'role-finance' } },
    }));
    expect(tx.adminSession.updateMany).toHaveBeenCalledWith({
      where: { adminUserId: 'user-1', revokedAt: null }, data: { revokedAt: expect.any(Date) },
    });
  });

  it('keeps the original role without creating a duplicate', async () => {
    const { prisma, tx, hashes } = setup();
    await provisionAdmin(prisma as never, hashes as never, input);
    expect(tx.adminUserRole.upsert).toHaveBeenCalledTimes(1);
    expect(tx.adminUserRole.upsert.mock.calls[0][0].update).toEqual({});
  });

  it('does not revoke sessions in create mode', async () => {
    const { prisma, tx, hashes } = setup({ existingUser: null, emailUser: null });
    await provisionAdmin(prisma as never, hashes as never, { ...input, updateMode: false });
    expect(tx.adminUser.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ roles: { create: { roleId: 'role-finance' } } }),
    }));
    expect(tx.adminUserRole.deleteMany).not.toHaveBeenCalled();
    expect(tx.adminSession.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['missing role', { role: null }],
    ['disabled role', { role: { id: 'role-finance', status: CommonStatus.disabled } }],
    ['email conflict', { emailUser: { id: 'other-user' } }],
  ])('%s fails before any user, role, or session mutation', async (_name, options) => {
    const { prisma, tx, hashes } = setup(options as never);
    await expect(provisionAdmin(prisma as never, hashes as never, input)).rejects.toThrow();
    expect(tx.adminUser.update).not.toHaveBeenCalled();
    expect(tx.adminUser.create).not.toHaveBeenCalled();
    expect(tx.adminUserRole.deleteMany).not.toHaveBeenCalled();
    expect(tx.adminUserRole.upsert).not.toHaveBeenCalled();
    expect(tx.adminSession.updateMany).not.toHaveBeenCalled();
  });

  it('never includes password, password hash, or session token in CLI output', () => {
    const output = formatAdminProvisionResult({ id: 'user-1', username: 'admin', updated: true });
    expect(output).toBe('Admin user updated: username=admin id=user-1');
    expect(output).not.toMatch(/correct-horse-42|scrypt-hash|session-token|passwordHash/);
    expect(redactCliError(new Error(`failure: ${input.password}`), input.password)).toBe('failure: [REDACTED]');
  });
});
