import { CommonStatus } from '@prisma/client';
import { AdminUsersService } from './admin-users.service';

describe('AdminUsersService role catalog', () => {
  it('returns only active roles as assignable roles', async () => {
    const activeRole = { id: 'role-new', code: 'custom_new', name: 'New role', description: null, status: CommonStatus.active };
    const prisma = { role: { findMany: jest.fn().mockResolvedValue([activeRole]) } };
    const service = new AdminUsersService(prisma as never, {} as never, {} as never);

    await expect(service.listRoles()).resolves.toEqual([activeRole]);
    expect(prisma.role.findMany).toHaveBeenCalledWith({
      where: { status: CommonStatus.active },
      select: { id: true, code: true, name: true, description: true, status: true },
      orderBy: { code: 'asc' },
    });
  });
});
