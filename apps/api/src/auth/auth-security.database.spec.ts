import { CommonStatus, PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AuditService } from '../audit/audit.service';
import { AuthGuard } from './auth.guard';
import { AuthService, hashSessionToken } from './auth.service';
import { PasswordHashService } from './password-hash.service';

const databaseDescribe = process.env.TASK55_DATABASE_TESTS === '1' ? describe : describe.skip;

databaseDescribe('Task 55 auth security PostgreSQL integration', () => {
  jest.setTimeout(180_000);
  const baseUrl = process.env.DATABASE_URL!;
  const schema = `task55_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  const passwords = new PasswordHashService();
  let adminClient: PrismaClient;
  let client: PrismaClient;
  let auth: AuthService;
  let roleId: string;

  beforeAll(async () => {
    if (!baseUrl) throw new Error('DATABASE_URL is required when TASK55_DATABASE_TESTS=1.');
    adminClient = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await adminClient.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const command = process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm prisma migrate deploy'] }
      : { file: 'pnpm', args: ['prisma', 'migrate', 'deploy'] };
    execFileSync(command.file, command.args, { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' });
    client = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
    roleId = (await client.role.create({ data: { code: 'task55_admin', name: 'Task 55 Admin' } })).id;
    auth = new AuthService(client as never, passwords, { sessionTtlHours: 12 } as never, new AuditService(client as never));
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (adminClient) {
      await adminClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminClient.$disconnect();
    }
  });

  it('lists only own active sessions, marks current, bounds UA and returns no secrets', async () => {
    const first = await createUser('list-a', 'ListPassword123');
    const second = await createUser('list-b', 'ListPassword123');
    const loginA1 = await auth.login({ username: first.username, password: 'ListPassword123' }, { ipAddress: '192.168.10.25', userAgent: '<script>x</script>'.repeat(100) });
    const loginA2 = await auth.login({ username: first.username, password: 'ListPassword123' }, { ipAddress: '10.0.0.7', userAgent: 'browser-a2' });
    await auth.login({ username: second.username, password: 'ListPassword123' }, { userAgent: 'other-user' });
    const current = await sessionId(loginA2.token);
    const sessions = await auth.listSessions(first.id, current);
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((entry) => entry.isCurrent).map((entry) => entry.id)).toEqual([current]);
    expect(sessions.every((entry) => entry.userAgent === null || entry.userAgent.length <= 512)).toBe(true);
    expect(sessions.some((entry) => entry.ipAddress === '192.168.*.*')).toBe(true);
    expect(JSON.stringify(sessions)).not.toMatch(/tokenHash|passwordHash|other-user|ListPassword123/);
    await expectTokenValid(loginA1.token);
  });

  it('changes password atomically, revokes all sessions, and writes a secret-free audit', async () => {
    const user = await createUser('change', 'OriginalPassword123');
    const first = await auth.login({ username: user.username, password: 'OriginalPassword123' }, {});
    const second = await auth.login({ username: user.username, password: 'OriginalPassword123' }, {});
    const actor = { userId: user.id, roleCode: 'task55_admin', permissions: [] };
    await expect(auth.changePassword({ currentPassword: 'WrongPassword123', newPassword: 'ReplacementPassword123', confirmPassword: 'ReplacementPassword123' }, actor)).rejects.toMatchObject({ message: 'Current password is incorrect.' });
    await expect(auth.changePassword({ currentPassword: 'OriginalPassword123', newPassword: 'OriginalPassword123', confirmPassword: 'OriginalPassword123' }, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(auth.changePassword({ currentPassword: 'OriginalPassword123', newPassword: 'weak', confirmPassword: 'weak' }, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(auth.changePassword({ currentPassword: 'OriginalPassword123', newPassword: 'ReplacementPassword123', confirmPassword: 'ReplacementPassword123' }, actor)).resolves.toEqual({ success: true });
    await expectTokenRejected(first.token);
    await expectTokenRejected(second.token);
    await expect(auth.login({ username: user.username, password: 'OriginalPassword123' }, {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(auth.login({ username: user.username, password: 'ReplacementPassword123' }, {})).resolves.toMatchObject({ actor: { userId: user.id } });
    const audit = await client.auditLog.findFirstOrThrow({ where: { actorUserId: user.id, action: 'auth.change_password' } });
    expect(JSON.stringify(audit)).not.toMatch(/OriginalPassword123|ReplacementPassword123|passwordHash|tokenHash|authorization/i);
  });

  it('revokes only owned sessions, preserves current when revoking another, and logout-all is user-scoped', async () => {
    const owner = await createUser('owner', 'OwnerPassword123');
    const other = await createUser('other', 'OtherPassword123');
    const ownerA = await auth.login({ username: owner.username, password: 'OwnerPassword123' }, {});
    const ownerB = await auth.login({ username: owner.username, password: 'OwnerPassword123' }, {});
    const otherLogin = await auth.login({ username: other.username, password: 'OtherPassword123' }, {});
    const ownerAId = await sessionId(ownerA.token);
    const ownerBId = await sessionId(ownerB.token);
    const otherId = await sessionId(otherLogin.token);
    const actor = { userId: owner.id, roleCode: 'task55_admin', permissions: [] };

    await expect(auth.revokeSession(otherId, ownerAId, actor)).resolves.toEqual({ success: true, currentSessionRevoked: false });
    await expectTokenValid(otherLogin.token);
    await expect(auth.revokeSession(ownerBId, ownerAId, actor)).resolves.toEqual({ success: true, currentSessionRevoked: false });
    await expectTokenRejected(ownerB.token);
    await expectTokenValid(ownerA.token);
    await expect(auth.revokeSession(ownerBId, ownerAId, actor)).resolves.toEqual({ success: true, currentSessionRevoked: false });

    await auth.logoutAll(actor);
    await expectTokenRejected(ownerA.token);
    await expectTokenValid(otherLogin.token);
  });

  it('keeps ordinary logout scoped to current session and rolls back password/session writes when audit fails', async () => {
    const user = await createUser('rollback', 'RollbackPassword123');
    const first = await auth.login({ username: user.username, password: 'RollbackPassword123' }, {});
    const second = await auth.login({ username: user.username, password: 'RollbackPassword123' }, {});
    const firstId = await sessionId(first.token);
    const actor = { userId: user.id, roleCode: 'task55_admin', permissions: [] };
    await auth.logout(firstId, actor);
    await expectTokenRejected(first.token);
    await expectTokenValid(second.token);

    const failing = new AuthService(client as never, passwords, { sessionTtlHours: 12 } as never, { success: jest.fn().mockRejectedValue(new Error('audit failed')) } as never);
    await expect(failing.changePassword({ currentPassword: 'RollbackPassword123', newPassword: 'NeverCommitted123', confirmPassword: 'NeverCommitted123' }, actor)).rejects.toThrow('audit failed');
    await expectTokenValid(second.token);
    await expect(auth.login({ username: user.username, password: 'RollbackPassword123' }, {})).resolves.toMatchObject({ actor: { userId: user.id } });
    await expect(auth.login({ username: user.username, password: 'NeverCommitted123' }, {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  async function createUser(suffix: string, password: string) {
    return client.adminUser.create({ data: {
      username: `task55_${suffix}_${randomUUID().slice(0, 8)}`,
      displayName: suffix,
      passwordHash: await passwords.hash(password),
      status: CommonStatus.active,
      roles: { create: { roleId } },
    } });
  }

  async function sessionId(token: string) {
    return (await client.adminSession.findUniqueOrThrow({ where: { tokenHash: hashSessionToken(token) }, select: { id: true } })).id;
  }

  async function expectTokenValid(token: string) { await expect(runGuard(client, token)).resolves.toBe(true); }
  async function expectTokenRejected(token: string) { await expect(runGuard(client, token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' }); }
});

function withSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function runGuard(client: PrismaClient, token: string) {
  const guard = new AuthGuard(client as never, { getAllAndOverride: () => false } as never);
  const request = { headers: { authorization: `Bearer ${token}` }, ip: '127.0.0.1' };
  return guard.canActivate({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as never);
}
