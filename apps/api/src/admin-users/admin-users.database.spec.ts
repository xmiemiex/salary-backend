import { CommonStatus, PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AuditService } from '../audit/audit.service';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { Actor } from '../auth/auth.types';
import { PasswordHashService } from '../auth/password-hash.service';
import { AdminUsersService } from './admin-users.service';

const databaseDescribe = process.env.TASK53_DATABASE_TESTS === '1' ? describe : describe.skip;

databaseDescribe('AdminUsersService PostgreSQL integration', () => {
  jest.setTimeout(180_000);
  const baseUrl = process.env.DATABASE_URL!;
  const schema = `task53_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  let adminClient: PrismaClient;
  let clientA: PrismaClient;
  let clientB: PrismaClient;
  let serviceA: AdminUsersService;
  let serviceB: AdminUsersService;
  let actor: Actor;
  let superRoleId: string;
  let normalRoleId: string;
  let disabledRoleId: string;

  beforeAll(async () => {
    if (!baseUrl) throw new Error('DATABASE_URL is required when TASK53_DATABASE_TESTS=1.');
    adminClient = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await adminClient.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const migrationCommand = process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm prisma migrate deploy'] }
      : { file: 'pnpm', args: ['prisma', 'migrate', 'deploy'] };
    execFileSync(migrationCommand.file, migrationCommand.args, {
      cwd: root,
      env: { ...process.env, DATABASE_URL: schemaUrl },
      stdio: 'pipe',
    });
    clientA = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
    clientB = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
    const [superRole, normalRole, disabledRole] = await Promise.all([
      clientA.role.create({ data: { code: 'super_admin', name: 'Super Administrator' } }),
      clientA.role.create({ data: { code: 'task53_operator', name: 'Operator' } }),
      clientA.role.create({ data: { code: 'task53_disabled', name: 'Disabled', status: CommonStatus.disabled } }),
    ]);
    superRoleId = superRole.id;
    normalRoleId = normalRole.id;
    disabledRoleId = disabledRole.id;
    const actorUser = await clientA.adminUser.create({
      data: { username: 'task53_actor', displayName: 'actor', email: 'actor@task53.test', passwordHash: 'fixture', roles: { create: { roleId: normalRoleId } } },
    });
    actor = { userId: actorUser.id, roleCode: 'task53_operator', permissions: ['admin_users.manage'] };
    serviceA = new AdminUsersService(clientA as never, new PasswordHashService(), new AuditService(clientA as never));
    serviceB = new AdminUsersService(clientB as never, new PasswordHashService(), new AuditService(clientB as never));
  });

  afterAll(async () => {
    await Promise.allSettled([clientA?.$disconnect(), clientB?.$disconnect()]);
    if (adminClient) {
      await adminClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminClient.$disconnect();
    }
  });

  it('creates safe DTOs, rejects duplicates and disabled roles, and never audits secrets', async () => {
    const assignableRoles = await serviceA.listRoles();
    expect(assignableRoles.map((role) => role.id)).toEqual(expect.arrayContaining([superRoleId, normalRoleId]));
    expect(assignableRoles.map((role) => role.id)).not.toContain(disabledRoleId);
    const created = await serviceA.create({
      username: 'task53_created', email: '  CREATED@TASK53.TEST ', password: 'Task53Password123', roleIds: [normalRoleId], status: 'active',
    }, actor);
    expect(created.email).toBe('created@task53.test');
    expect(JSON.stringify(created)).not.toMatch(/password|tokenHash/i);

    await expect(serviceA.create({
      username: 'task53_created', email: 'other@task53.test', password: 'Task53Password123', roleIds: [normalRoleId],
    }, actor)).rejects.toMatchObject({ code: 'DUPLICATE_RESOURCE' });
    await expect(serviceA.create({
      username: 'task53_other', email: 'created@task53.test', password: 'Task53Password123', roleIds: [normalRoleId],
    }, actor)).rejects.toMatchObject({ code: 'DUPLICATE_RESOURCE' });
    await expect(serviceA.create({
      username: 'task53_disabled_role', email: 'disabled@task53.test', password: 'Task53Password123', roleIds: [disabledRoleId],
    }, actor)).rejects.toMatchObject({ code: 'CONFLICT' });

    const audits = await clientA.auditLog.findMany({ where: { objectId: created.id } });
    expect(JSON.stringify(audits)).not.toContain('Task53Password123');
    expect(JSON.stringify(audits)).not.toMatch(/passwordHash|tokenHash/);
  });

  it('replaces roles and revokes sessions; reset and disable revoke sessions; enable never restores them', async () => {
    const auth = new AuthService(clientA as never, new PasswordHashService(), { sessionTtlHours: 12 } as never, new AuditService(clientA as never));
    const created = await serviceA.create({
      username: 'task53_sessions', email: 'sessions@task53.test', password: 'Task53Password123', roleIds: [normalRoleId],
    }, actor);
    const firstLogin = await auth.login({ username: created.username, password: 'Task53Password123' }, {});
    const updated = await serviceA.update(created.id, { email: created.email, roleIds: [superRoleId], status: 'active' }, actor);
    expect(updated.roles.map((role) => role.id)).toEqual([superRoleId]);
    await expectOldTokenRejected(clientA, firstLogin.token);

    const secondLogin = await auth.login({ username: created.username, password: 'Task53Password123' }, {});
    await serviceA.resetPassword(created.id, { password: 'ReplacementPassword123', confirmPassword: 'ReplacementPassword123' }, actor);
    await expectOldTokenRejected(clientA, secondLogin.token);
    await expect(auth.login({ username: created.username, password: 'Task53Password123' }, {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    await serviceA.create({ username: 'task53_super_backup', email: 'super-backup@task53.test', password: 'Task53Password123', roleIds: [superRoleId] }, actor);
    const thirdLogin = await auth.login({ username: created.username, password: 'ReplacementPassword123' }, {});
    await serviceA.setEnabled(created.id, false, actor);
    await expectOldTokenRejected(clientA, thirdLogin.token);
    await expect(auth.login({ username: created.username, password: 'ReplacementPassword123' }, {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await serviceA.setEnabled(created.id, true, actor);
    await expectOldTokenRejected(clientA, thirdLogin.token);
    await expect(auth.login({ username: created.username, password: 'ReplacementPassword123' }, {})).resolves.toMatchObject({ actor: { userId: created.id } });
  });

  it('prevents self-disable and self-removal of super_admin', async () => {
    const self = await serviceA.create({ username: 'task53_self', email: 'self@task53.test', password: 'Task53Password123', roleIds: [superRoleId] }, actor);
    const selfActor = { ...actor, userId: self.id, roleCode: 'super_admin' };
    await expect(serviceA.setEnabled(self.id, false, selfActor)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(serviceA.update(self.id, { roleIds: [normalRoleId] }, selfActor)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rolls back all database writes if success audit fails', async () => {
    const failingAudit = { success: jest.fn().mockRejectedValue(new Error('audit failed')) };
    const service = new AdminUsersService(clientA as never, new PasswordHashService(), failingAudit as never);
    await expect(service.create({ username: 'task53_rollback', email: 'rollback@task53.test', password: 'Task53Password123', roleIds: [normalRoleId] }, actor)).rejects.toThrow('audit failed');
    await expect(clientA.adminUser.findUnique({ where: { username: 'task53_rollback' } })).resolves.toBeNull();
  });

  it('concurrent attempts cannot remove every enabled super_admin', async () => {
    await clientA.adminUser.updateMany({ where: { roles: { some: { roleId: superRoleId } } }, data: { status: CommonStatus.disabled } });
    const [first, second] = await Promise.all([
      serviceA.create({ username: 'task53_concurrent_a', email: 'concurrent-a@task53.test', password: 'Task53Password123', roleIds: [superRoleId] }, actor),
      serviceA.create({ username: 'task53_concurrent_b', email: 'concurrent-b@task53.test', password: 'Task53Password123', roleIds: [superRoleId] }, actor),
    ]);
    const results = await Promise.allSettled([
      serviceA.setEnabled(first.id, false, actor),
      serviceB.setEnabled(second.id, false, actor),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const enabledCount = await clientA.adminUser.count({ where: { status: CommonStatus.active, roles: { some: { roleId: superRoleId } } } });
    expect(enabledCount).toBe(1);
  });
});

function withSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

async function expectOldTokenRejected(client: PrismaClient, token: string) {
  const guard = new AuthGuard(client as never, { getAllAndOverride: () => false } as never);
  const request = { headers: { authorization: `Bearer ${token}` }, ip: '127.0.0.1' };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  };
  await expect(guard.canActivate(context as never)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
}
