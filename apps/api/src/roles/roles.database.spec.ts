import { CommonStatus, PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { RolesService } from './roles.service';
const databaseDescribe = process.env.TASK54_DATABASE_TESTS === '1' ? describe : describe.skip;
databaseDescribe('RolesService PostgreSQL integration', () => {
  jest.setTimeout(180_000);
  const baseUrl = process.env.DATABASE_URL!; const schema = `task54_${randomUUID().replace(/-/g, '')}`; const schemaUrl = withSchema(baseUrl, schema); const root = path.resolve(__dirname, '../../../..');
  let admin: PrismaClient; let a: PrismaClient; let b: PrismaClient; let serviceA: RolesService; let serviceB: RolesService; let actor: Actor; let permissionIds: string[]; let superId: string;
  beforeAll(async () => {
    if (!baseUrl) throw new Error('DATABASE_URL is required when TASK54_DATABASE_TESTS=1.'); admin = new PrismaClient({ datasources: { db: { url: baseUrl } } }); await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const command = process.platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm prisma migrate deploy'] } : { file: 'pnpm', args: ['prisma', 'migrate', 'deploy'] }; execFileSync(command.file, command.args, { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' });
    a = new PrismaClient({ datasources: { db: { url: schemaUrl } } }); b = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
    const codes = ['role.read', 'role.manage', 'admin_users.read', 'admin_users.manage', 'salary.view_self']; const permissions = [];
    for (const code of codes) permissions.push(await a.permission.upsert({ where: { code }, update: {}, create: { code, name: code } })); permissionIds = permissions.map((p) => p.id);
    const superRole = await a.role.create({ data: { code: 'super_admin', name: 'Super Administrator', permissions: { createMany: { data: permissionIds.map((permissionId) => ({ permissionId })) } } } }); superId = superRole.id;
    const actorRole = await a.role.create({ data: { code: 'task54_actor', name: 'Task54 Actor', permissions: { create: { permissionId: permissionIds[0] } } } });
    const actorUser = await a.adminUser.create({ data: { username: 'task54_actor', displayName: 'actor', passwordHash: 'fixture', roles: { create: { roleId: actorRole.id } } } }); actor = { userId: actorUser.id, roleCode: actorRole.code, permissions: ['role.manage'] };
    serviceA = new RolesService(a as never, new AuditService(a as never)); serviceB = new RolesService(b as never, new AuditService(b as never));
  });
  afterAll(async () => { await Promise.allSettled([a?.$disconnect(), b?.$disconnect()]); if (admin) { await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.$disconnect(); } });
  it('creates/list/details safe DTOs and rejects duplicate, unknown and duplicate permission IDs', async () => {
    const created = await serviceA.create({ name: '临时只读角色', description: 'safe', permissionIds: [permissionIds[0]] }, actor); expect(created.code).toMatch(/^custom_/); expect(JSON.stringify(created)).not.toMatch(/passwordHash|tokenHash|encryptedPayload/i);
    await expect(serviceA.create({ name: '临时只读角色', permissionIds: [permissionIds[0]] }, actor)).rejects.toMatchObject({ code: 'DUPLICATE_RESOURCE' });
    await expect(serviceA.create({ name: '未知权限', permissionIds: ['11111111-1111-4111-8111-111111111111'] }, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(serviceA.create({ name: '重复权限', permissionIds: [permissionIds[0], permissionIds[0]] }, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await serviceA.list({ search: '临时', page: '1', pageSize: '10' })).items).toHaveLength(1); expect((await serviceA.permissions())[0]).toHaveProperty('module');
  });
  it('atomically replaces final permissions, revokes all role sessions, but description-only edits do not', async () => {
    const role = await serviceA.create({ name: '会话角色', permissionIds: [permissionIds[0]] }, actor); const user = await a.adminUser.create({ data: { username: 'task54_session', displayName: 'session', passwordHash: 'fixture', roles: { create: { roleId: role.id } }, sessions: { create: { tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60000) } } } });
    await serviceA.update(role.id, { description: 'description only' }, actor); expect(await a.adminSession.count({ where: { adminUserId: user.id, revokedAt: null } })).toBe(1);
    const updated = await serviceA.update(role.id, { permissionIds: [permissionIds[1], permissionIds[4]] }, actor); expect(updated.permissions.map((p) => p.id).sort()).toEqual([permissionIds[1], permissionIds[4]].sort()); expect(await a.adminSession.count({ where: { adminUserId: user.id, revokedAt: null } })).toBe(0);
  });
  it('protects super_admin and assigned roles including constructed update requests', async () => {
    await expect(serviceA.setEnabled(superId, false, actor)).rejects.toMatchObject({ code: 'CONFLICT' }); await expect(serviceA.update(superId, { status: 'disabled' }, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(serviceA.update(superId, { permissionIds: [permissionIds[0], permissionIds[1]] }, actor)).rejects.toMatchObject({ code: 'CONFLICT' }); await expect(serviceA.update(superId, { name: 'super-admin' }, actor)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); expect((await serviceA.get(superId)).code).toBe('super_admin');
    const used = await serviceA.create({ name: '已使用角色', permissionIds: [permissionIds[0]] }, actor); await a.adminUserRole.create({ data: { adminUserId: actor.userId, roleId: used.id } }); await expect(serviceA.setEnabled(used.id, false, actor)).rejects.toMatchObject({ code: 'CONFLICT' }); await expect(serviceA.update(used.id, { status: 'disabled' }, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('rolls back business writes when audit fails and stores bounded non-sensitive diffs', async () => {
    const failing = new RolesService(a as never, { success: jest.fn().mockRejectedValue(new Error('audit failed')) } as never); await expect(failing.create({ name: '回滚角色', permissionIds: [permissionIds[0]] }, actor)).rejects.toThrow('audit failed'); expect(await a.role.findFirst({ where: { name: '回滚角色' } })).toBeNull();
    const role = await serviceA.create({ name: '审计角色', permissionIds: [permissionIds[0]] }, actor); await serviceA.update(role.id, { permissionIds: [permissionIds[1]] }, actor); const audit = await a.auditLog.findFirstOrThrow({ where: { objectId: role.id, action: 'role.update' }, orderBy: { createdAt: 'desc' } }); expect(JSON.stringify(audit)).toContain('role.read'); expect(JSON.stringify(audit)).not.toMatch(/passwordHash|tokenHash|DATABASE_URL/i);
  });
  it('concurrent writes cannot bypass super_admin core permission protection', async () => {
    const results = await Promise.allSettled([serviceA.update(superId, { permissionIds: [permissionIds[0], permissionIds[1], permissionIds[2]] }, actor), serviceB.update(superId, { permissionIds: [permissionIds[0], permissionIds[1], permissionIds[3]] }, actor)]); expect(results.every((r) => r.status === 'rejected')).toBe(true); const codes = (await serviceA.get(superId)).permissions.map((p) => p.code); expect(['role.read', 'role.manage', 'admin_users.read', 'admin_users.manage'].every((code) => codes.includes(code))).toBe(true);
  });
});
function withSchema(databaseUrl: string, schema: string) { const url = new URL(databaseUrl); url.searchParams.set('schema', schema); return url.toString(); }
