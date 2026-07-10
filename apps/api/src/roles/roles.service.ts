import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';

const SUPER_ADMIN = 'super_admin';
const CORE_SUPER_PERMISSIONS = ['role.read', 'role.manage', 'admin_users.read', 'admin_users.manage'] as const;
const MAX_AUDIT_PERMISSION_CODES = 200;
const MAX_ATTEMPTS = 3;
// PostgreSQL accepts the canonical UUID text shape without requiring RFC version bits.
// Existing idempotent data migrations use md5(...):uuid, so rejecting those IDs would
// make valid catalog permissions impossible to assign.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELECT = {
  id: true, code: true, name: true, description: true, status: true, createdAt: true, updatedAt: true,
  permissions: { select: { permission: { select: { id: true, code: true, name: true, description: true } } }, orderBy: { permission: { code: 'asc' as const } } },
  _count: { select: { permissions: true, users: true } },
} satisfies Prisma.RoleSelect;
type RoleRecord = Prisma.RoleGetPayload<{ select: typeof SELECT }>;

export type CreateRoleInput = { name: unknown; description?: unknown; status?: unknown; permissionIds: unknown };
export type UpdateRoleInput = { name?: unknown; description?: unknown; status?: unknown; permissionIds?: unknown };

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(query: Record<string, unknown> = {}) {
    rejectUnknown(query, ['page', 'pageSize', 'search', 'status'], 'query');
    const page = positiveInt(query.page, 'page', 1, Number.MAX_SAFE_INTEGER);
    const pageSize = positiveInt(query.pageSize, 'pageSize', 20, 100);
    const search = optionalText(query.search, 'search', 128);
    const status = query.status === undefined ? undefined : parseStatus(query.status);
    const where: Prisma.RoleWhereInput = { status, name: search ? { contains: search, mode: 'insensitive' } : undefined };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.role.count({ where }),
      this.prisma.role.findMany({ where, select: SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return { total, page, pageSize, items: items.map(dto) };
  }

  async permissions() {
    const rows = await this.prisma.permission.findMany({ select: { id: true, code: true, name: true, description: true }, orderBy: { code: 'asc' } });
    return rows.map((row) => ({ ...row, module: row.code.split('.')[0] || 'other' }));
  }

  async get(idInput: string) {
    const role = await this.prisma.role.findUnique({ where: { id: uuid(idInput, 'id') }, select: SELECT });
    if (!role) throw new AppError(ERROR_CODES.NOT_FOUND, 'Role not found.');
    return dto(role);
  }

  async create(input: CreateRoleInput, actor: Actor) {
    rejectUnknown(input, ['name', 'description', 'status', 'permissionIds'], 'body');
    const name = roleName(input.name);
    assertNotReservedName(name);
    const description = descriptionValue(input.description);
    const status = input.status === undefined ? CommonStatus.active : parseStatus(input.status);
    const permissionIds = permissionIdsValue(input.permissionIds);
    const code = `custom_${createHash('sha256').update(normalizeName(name)).digest('hex').slice(0, 24)}`;
    try {
      return await this.serializable(async (tx) => {
        await assertUniqueName(tx, name);
        const permissions = await requirePermissions(tx, permissionIds);
        const created = await tx.role.create({ data: { code, name, description, status, permissions: { createMany: { data: permissionIds.map((permissionId) => ({ permissionId })) } } }, select: SELECT });
        await this.audit.success({ ...auditActor(actor), action: 'role.create', objectType: 'role', objectId: created.id, afterData: auditSnapshot(created), changedFields: ['name', 'description', 'status', 'permissions'], requestPayload: { name, description, status, permissionIds }, }, tx);
        return { ...dto(created), permissions: permissions.map(permissionDto) };
      });
    } catch (error) { throw translate(error); }
  }

  async update(idInput: string, input: UpdateRoleInput, actor: Actor) {
    const id = uuid(idInput, 'id');
    rejectUnknown(input, ['name', 'description', 'status', 'permissionIds'], 'body');
    if (!Object.keys(input).length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'At least one editable field is required.');
    const name = input.name === undefined ? undefined : roleName(input.name);
    const description = input.description === undefined ? undefined : descriptionValue(input.description);
    const status = input.status === undefined ? undefined : parseStatus(input.status);
    const permissionIds = input.permissionIds === undefined ? undefined : permissionIdsValue(input.permissionIds);
    return this.serializable(async (tx) => {
      const before = await tx.role.findUnique({ where: { id }, select: SELECT });
      if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, 'Role not found.');
      if (name !== undefined && name !== before.name) { assertNotReservedName(name); await assertUniqueName(tx, name, id); }
      if (before.code === SUPER_ADMIN && status === CommonStatus.disabled) throw new AppError(ERROR_CODES.CONFLICT, 'super_admin cannot be disabled.');
      if (status === CommonStatus.disabled && before.status !== CommonStatus.disabled && before._count.users > 0) throw new AppError(ERROR_CODES.CONFLICT, 'Role is still assigned to administrators.');
      let nextPermissions = before.permissions.map((p) => p.permission);
      if (permissionIds) {
        nextPermissions = await requirePermissions(tx, permissionIds);
        if (before.code === SUPER_ADMIN) assertCorePermissions(nextPermissions.map((p) => p.code));
      }
      const permissionChanged = permissionIds !== undefined && !sameSet(before.permissions.map((p) => p.permission.id), permissionIds);
      if (permissionChanged) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: permissionIds!.map((permissionId) => ({ roleId: id, permissionId })) });
        await revokeRoleSessions(tx, id);
      }
      await tx.role.update({ where: { id }, data: { name, description, status } });
      const after = await tx.role.findUniqueOrThrow({ where: { id }, select: SELECT });
      const changed = changedFields(before, after);
      if (!changed.length) throw new AppError(ERROR_CODES.CONFLICT, 'Role already has the requested values.');
      const beforeCodes = before.permissions.map((p) => p.permission.code);
      const afterCodes = nextPermissions.map((p) => p.code);
      await this.audit.success({ ...auditActor(actor), action: 'role.update', objectType: 'role', objectId: id, beforeData: auditSnapshot(before), afterData: auditSnapshot(after), changedFields: changed, requestPayload: { id, ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}), ...(status !== undefined ? { status } : {}), ...(permissionIds ? { permissionIds } : {}) , permissionChanges: permissionDiff(beforeCodes, afterCodes) } }, tx);
      return dto(after);
    });
  }

  async setEnabled(idInput: string, enabled: boolean, actor: Actor) {
    const id = uuid(idInput, 'id');
    return this.serializable(async (tx) => {
      const before = await tx.role.findUnique({ where: { id }, select: SELECT });
      if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, 'Role not found.');
      if (!enabled && before.code === SUPER_ADMIN) throw new AppError(ERROR_CODES.CONFLICT, 'super_admin cannot be disabled.');
      if (!enabled && before._count.users > 0) throw new AppError(ERROR_CODES.CONFLICT, 'Role is still assigned to administrators.');
      const next = enabled ? CommonStatus.active : CommonStatus.disabled;
      if (before.status === next) throw new AppError(ERROR_CODES.CONFLICT, `Role is already ${next}.`);
      await tx.role.update({ where: { id }, data: { status: next } });
      if (!enabled) await revokeRoleSessions(tx, id);
      const after = await tx.role.findUniqueOrThrow({ where: { id }, select: SELECT });
      await this.audit.success({ ...auditActor(actor), action: enabled ? 'role.enable' : 'role.disable', objectType: 'role', objectId: id, beforeData: auditSnapshot(before), afterData: auditSnapshot(after), changedFields: ['status'], requestPayload: { id } }, tx);
      return dto(after);
    });
  }

  private async serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) try { return await this.prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); } catch (error) { if (!isConflict(error) || attempt === MAX_ATTEMPTS) { if (isConflict(error)) throw new AppError(ERROR_CODES.CONFLICT, 'Role changed concurrently; retry the request.'); throw error; } }
    throw new AppError(ERROR_CODES.CONFLICT, 'Role changed concurrently; retry the request.');
  }
}

function dto(role: RoleRecord) { return { id: role.id, code: role.code, name: role.name, description: role.description, status: role.status, system: role.code === SUPER_ADMIN, permissionCount: role._count.permissions, adminCount: role._count.users, permissions: role.permissions.map((p) => permissionDto(p.permission)), createdAt: role.createdAt, updatedAt: role.updatedAt }; }
function permissionDto(p: { id: string; code: string; name: string; description: string | null }) { return { ...p, module: p.code.split('.')[0] || 'other' }; }
function auditSnapshot(role: RoleRecord) { return { id: role.id, code: role.code, name: role.name, description: role.description, status: role.status, permissionCodes: role.permissions.map((p) => p.permission.code).sort(), adminCount: role._count.users }; }
function permissionDiff(before: string[], after: string[]) { return { added: after.filter((v) => !before.includes(v)).sort().slice(0, MAX_AUDIT_PERMISSION_CODES), removed: before.filter((v) => !after.includes(v)).sort().slice(0, MAX_AUDIT_PERMISSION_CODES), truncated: before.length > MAX_AUDIT_PERMISSION_CODES || after.length > MAX_AUDIT_PERMISSION_CODES }; }
function changedFields(a: RoleRecord, b: RoleRecord) { const out: string[] = []; if (a.name !== b.name) out.push('name'); if (a.description !== b.description) out.push('description'); if (a.status !== b.status) out.push('status'); if (!sameSet(a.permissions.map((p) => p.permission.id), b.permissions.map((p) => p.permission.id))) out.push('permissions'); return out; }
async function requirePermissions(tx: Prisma.TransactionClient, ids: string[]) { const rows = await tx.permission.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, description: true } }); if (rows.length !== ids.length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'One or more permissions do not exist.'); return rows; }
async function assertUniqueName(tx: Prisma.TransactionClient, name: string, excludeId?: string) { const row = await tx.role.findFirst({ where: { id: excludeId ? { not: excludeId } : undefined, name: { equals: name, mode: 'insensitive' } }, select: { id: true } }); if (row) throw new AppError(ERROR_CODES.DUPLICATE_RESOURCE, 'Role name already exists.'); }
async function revokeRoleSessions(tx: Prisma.TransactionClient, roleId: string) { await tx.adminSession.updateMany({ where: { revokedAt: null, adminUser: { roles: { some: { roleId } } } }, data: { revokedAt: new Date() } }); }
function assertCorePermissions(codes: string[]) { const missing = CORE_SUPER_PERMISSIONS.filter((c) => !codes.includes(c)); if (missing.length) throw new AppError(ERROR_CODES.CONFLICT, `super_admin core permissions cannot be removed: ${missing.join(', ')}.`); }
function roleName(value: unknown) { if (typeof value !== 'string') throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'name must be a string.'); const name = value.trim().replace(/\s+/g, ' '); if (name.length < 2 || name.length > 64 || !/^[\p{L}\p{N} _-]+$/u.test(name)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'name must be 2-64 letters, digits, spaces, underscores, or hyphens.'); return name; }
function normalizeName(name: string) { return name.normalize('NFKC').toLocaleLowerCase('en-US'); }
function assertNotReservedName(name: string) { if (normalizeName(name).replace(/[ -]+/g, '_') === SUPER_ADMIN) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'super_admin is a reserved role name.'); }
function descriptionValue(value: unknown): string | null { if (value === undefined || value === null || value === '') return null; if (typeof value !== 'string') throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'description must be a string or null.'); const text = value.trim(); if (text.length > 1000) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'description must not exceed 1000 characters.'); return text || null; }
function permissionIdsValue(value: unknown) { if (!Array.isArray(value) || value.length < 1 || value.length > 500) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'permissionIds must contain 1-500 items.'); const ids = value.map((v) => uuid(v, 'permissionIds')); if (new Set(ids).size !== ids.length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'permissionIds must not contain duplicates.'); return ids; }
function parseStatus(v: unknown) { if (v === CommonStatus.active || v === CommonStatus.disabled) return v; throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'status must be active or disabled.'); }
function uuid(v: unknown, field: string) { if (typeof v !== 'string' || !UUID.test(v)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must contain valid UUID values.`); return v; }
function optionalText(v: unknown, field: string, max: number) { if (v === undefined) return undefined; if (typeof v !== 'string') throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a string.`); const t = v.trim(); if (!t || t.length > max) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be 1-${max} characters.`); return t; }
function positiveInt(v: unknown, field: string, fallback: number, max: number) { if (v === undefined) return fallback; if (typeof v !== 'string' || !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > max) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be an integer between 1 and ${max}.`); return Number(v); }
function rejectUnknown(v: object, allowed: string[], location: string) { const unknown = Object.keys(v).filter((k) => !allowed.includes(k)); if (unknown.length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Unknown ${location} fields: ${unknown.join(', ')}.`); }
function sameSet(a: string[], b: string[]) { return a.length === b.length && a.every((v) => b.includes(v)); }
function auditActor(actor: Actor) { return { actorUserId: actor.userId, actorRole: actor.roleCode, ipAddress: actor.ipAddress, userAgent: actor.userAgent }; }
function isConflict(e: unknown) { return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034'; }
function translate(e: unknown) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return new AppError(ERROR_CODES.DUPLICATE_RESOURCE, 'Role name already exists.'); return e; }
