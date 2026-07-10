import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { PasswordHashService } from '../auth/password-hash.service';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';

const SUPER_ADMIN_CODE = 'super_admin';
const MAX_TRANSACTION_ATTEMPTS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SAFE_USER_SELECT = {
  id: true,
  username: true,
  email: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  roles: {
    select: { role: { select: { id: true, code: true, name: true, status: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
  sessions: {
    select: { lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' as const },
    take: 1,
  },
} satisfies Prisma.AdminUserSelect;

type SafeUserRecord = Prisma.AdminUserGetPayload<{ select: typeof SAFE_USER_SELECT }>;

export type CreateAdminUserInput = {
  username: unknown;
  email: unknown;
  password: unknown;
  roleIds: unknown;
  status?: unknown;
};

export type UpdateAdminUserInput = {
  email?: unknown;
  roleIds?: unknown;
  status?: unknown;
};

export type ResetAdminPasswordInput = {
  password: unknown;
  confirmPassword: unknown;
};

type AdminUsersQuery = {
  page?: unknown;
  pageSize?: unknown;
  search?: unknown;
  status?: unknown;
  roleId?: unknown;
};

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordHashes: PasswordHashService,
    private readonly audit: AuditService,
  ) {}

  async list(query: AdminUsersQuery = {}) {
    rejectUnknownKeys(query, ['page', 'pageSize', 'search', 'status', 'roleId'], 'query');
    const page = positiveInteger(query.page, 'page', 1, Number.MAX_SAFE_INTEGER);
    const pageSize = positiveInteger(query.pageSize, 'pageSize', 20, 100);
    const search = optionalText(query.search, 'search', 255);
    const status = query.status === undefined ? undefined : parseStatus(query.status, 'status');
    const roleId = query.roleId === undefined ? undefined : parseUuid(query.roleId, 'roleId');
    const where: Prisma.AdminUserWhereInput = {
      status,
      roles: roleId ? { some: { roleId } } : undefined,
      OR: search
        ? [
            { username: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const [total, records] = await this.prisma.$transaction([
      this.prisma.adminUser.count({ where }),
      this.prisma.adminUser.findMany({
        where,
        select: SAFE_USER_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, items: records.map(toSafeDto) };
  }

  async listRoles() {
    return this.prisma.role.findMany({
      where: { status: CommonStatus.active },
      select: { id: true, code: true, name: true, description: true, status: true },
      orderBy: { code: 'asc' },
    });
  }

  async get(idInput: string) {
    const id = parseUuid(idInput, 'id');
    const user = await this.prisma.adminUser.findUnique({ where: { id }, select: SAFE_USER_SELECT });
    if (!user) throw new AppError(ERROR_CODES.NOT_FOUND, 'Administrator not found.');
    return toSafeDto(user);
  }

  async create(input: CreateAdminUserInput, actor: Actor) {
    rejectUnknownKeys(input, ['username', 'email', 'password', 'roleIds', 'status'], 'body');
    const username = requiredUsername(input.username);
    const email = normalizeEmail(input.email);
    const password = requiredPassword(input.password);
    const roleIds = uniqueRoleIds(input.roleIds);
    const status = input.status === undefined ? CommonStatus.active : parseStatus(input.status, 'status');
    const passwordHash = await this.hashPassword(password);

    try {
      return await this.serializable(async (tx) => {
        const roles = await this.requireActiveRoles(tx, roleIds);
        const created = await tx.adminUser.create({
          data: {
            username,
            displayName: username,
            email,
            passwordHash,
            status,
            roles: { createMany: { data: roleIds.map((roleId) => ({ roleId })) } },
          },
          select: SAFE_USER_SELECT,
        });
        const dto = toSafeDto(created);
        await this.audit.success({
          ...auditActor(actor),
          action: 'admin_user.create',
          objectType: 'admin_user',
          objectId: created.id,
          afterData: auditSnapshot(created),
          changedFields: ['username', 'email', 'status', 'roles'],
          requestPayload: { username, email, status, roleIds },
        }, tx);
        return { ...dto, roles: roles.map(safeRole) };
      });
    } catch (error) {
      throw translateWriteError(error);
    }
  }

  async update(idInput: string, input: UpdateAdminUserInput, actor: Actor) {
    const id = parseUuid(idInput, 'id');
    rejectUnknownKeys(input, ['email', 'roleIds', 'status'], 'body');
    if (input.email === undefined && input.roleIds === undefined && input.status === undefined) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'At least one of email, roleIds, or status is required.');
    }
    const email = input.email === undefined ? undefined : normalizeEmail(input.email);
    const roleIds = input.roleIds === undefined ? undefined : uniqueRoleIds(input.roleIds);
    const status = input.status === undefined ? undefined : parseStatus(input.status, 'status');

    try {
      return await this.serializable(async (tx) => {
        const before = await tx.adminUser.findUnique({ where: { id }, select: SAFE_USER_SELECT });
        if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, 'Administrator not found.');
        if (roleIds) await this.requireActiveRoles(tx, roleIds);

        const superRole = await this.requireSuperAdminRole(tx);
        const currentRoleIds = before.roles.map((entry) => entry.role.id);
        const nextRoleIds = roleIds ?? currentRoleIds;
        const roleChanged = !sameSet(currentRoleIds, nextRoleIds);
        const nextStatus = status ?? before.status;
        const currentlySuper = currentRoleIds.includes(superRole.id);
        const remainsEnabledSuper = nextStatus === CommonStatus.active && nextRoleIds.includes(superRole.id);

        this.assertSelfProtection(actor, before.id, currentlySuper, nextStatus, nextRoleIds, superRole.id);
        if (before.status === CommonStatus.active && currentlySuper && !remainsEnabledSuper) {
          await this.assertAnotherEnabledSuperAdmin(tx, before.id, superRole.id);
        }

        if (roleChanged) {
          await tx.adminUserRole.deleteMany({ where: { adminUserId: id } });
          await tx.adminUserRole.createMany({ data: nextRoleIds.map((roleId) => ({ adminUserId: id, roleId })) });
        }
        await tx.adminUser.update({ where: { id }, data: { email, status } });
        if (roleChanged || (before.status === CommonStatus.active && nextStatus === CommonStatus.disabled)) {
          await revokeSessions(tx, id);
        }
        const after = await tx.adminUser.findUniqueOrThrow({ where: { id }, select: SAFE_USER_SELECT });
        const fields = changedAdminFields(before, after);
        if (fields.length === 0) throw new AppError(ERROR_CODES.CONFLICT, 'Administrator already has the requested values.');
        await this.audit.success({
          ...auditActor(actor),
          action: 'admin_user.update',
          objectType: 'admin_user',
          objectId: id,
          beforeData: auditSnapshot(before),
          afterData: auditSnapshot(after),
          changedFields: fields,
          requestPayload: { id, ...(email !== undefined ? { email } : {}), ...(status !== undefined ? { status } : {}), ...(roleIds ? { roleIds } : {}) },
        }, tx);
        return toSafeDto(after);
      });
    } catch (error) {
      throw translateWriteError(error);
    }
  }

  async resetPassword(idInput: string, input: ResetAdminPasswordInput, actor: Actor) {
    const id = parseUuid(idInput, 'id');
    rejectUnknownKeys(input, ['password', 'confirmPassword'], 'body');
    const password = requiredPassword(input.password);
    if (typeof input.confirmPassword !== 'string' || input.confirmPassword !== password) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Password confirmation does not match.');
    }
    const passwordHash = await this.hashPassword(password);
    return this.serializable(async (tx) => {
      const before = await tx.adminUser.findUnique({ where: { id }, select: SAFE_USER_SELECT });
      if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, 'Administrator not found.');
      await tx.adminUser.update({ where: { id }, data: { passwordHash } });
      await revokeSessions(tx, id);
      await this.audit.success({
        ...auditActor(actor),
        action: 'admin_user.reset_password',
        objectType: 'admin_user',
        objectId: id,
        beforeData: { id: before.id, username: before.username },
        afterData: { id: before.id, username: before.username, passwordReset: true },
        changedFields: ['password'],
        requestPayload: { id },
      }, tx);
      return { success: true };
    });
  }

  async setEnabled(idInput: string, enabled: boolean, actor: Actor) {
    const id = parseUuid(idInput, 'id');
    const nextStatus = enabled ? CommonStatus.active : CommonStatus.disabled;
    return this.serializable(async (tx) => {
      const before = await tx.adminUser.findUnique({ where: { id }, select: SAFE_USER_SELECT });
      if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, 'Administrator not found.');
      if (before.status === nextStatus) {
        throw new AppError(ERROR_CODES.CONFLICT, `Administrator is already ${enabled ? 'enabled' : 'disabled'}.`);
      }
      if (!enabled && actor.userId === id) {
        throw new AppError(ERROR_CODES.CONFLICT, 'You cannot disable your current administrator account.');
      }
      const superRole = await this.requireSuperAdminRole(tx);
      const currentlySuper = before.roles.some((entry) => entry.role.id === superRole.id);
      if (!enabled && currentlySuper) await this.assertAnotherEnabledSuperAdmin(tx, id, superRole.id);

      await tx.adminUser.update({ where: { id }, data: { status: nextStatus } });
      if (!enabled) await revokeSessions(tx, id);
      const after = await tx.adminUser.findUniqueOrThrow({ where: { id }, select: SAFE_USER_SELECT });
      await this.audit.success({
        ...auditActor(actor),
        action: enabled ? 'admin_user.enable' : 'admin_user.disable',
        objectType: 'admin_user',
        objectId: id,
        beforeData: auditSnapshot(before),
        afterData: auditSnapshot(after),
        changedFields: ['status'],
        requestPayload: { id },
      }, tx);
      return toSafeDto(after);
    });
  }

  private async requireActiveRoles(tx: Prisma.TransactionClient, roleIds: string[]) {
    const roles = await tx.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, code: true, name: true, status: true } });
    if (roles.length !== roleIds.length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'One or more roles do not exist.');
    if (roles.some((role) => role.status !== CommonStatus.active)) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Disabled roles cannot be assigned.');
    }
    return roles;
  }

  private async requireSuperAdminRole(tx: Prisma.TransactionClient) {
    const role = await tx.role.findUnique({ where: { code: SUPER_ADMIN_CODE }, select: { id: true, status: true } });
    if (!role) throw new AppError(ERROR_CODES.CONFLICT, 'The stable super_admin role is missing.');
    return role;
  }

  private assertSelfProtection(actor: Actor, targetId: string, currentlySuper: boolean, nextStatus: CommonStatus, nextRoleIds: string[], superRoleId: string) {
    if (actor.userId !== targetId) return;
    if (nextStatus === CommonStatus.disabled) {
      throw new AppError(ERROR_CODES.CONFLICT, 'You cannot disable your current administrator account.');
    }
    if (currentlySuper && !nextRoleIds.includes(superRoleId)) {
      throw new AppError(ERROR_CODES.CONFLICT, 'You cannot remove your own super_admin role.');
    }
  }

  private async assertAnotherEnabledSuperAdmin(tx: Prisma.TransactionClient, excludedUserId: string, superRoleId: string) {
    const count = await tx.adminUser.count({
      where: {
        id: { not: excludedUserId },
        status: CommonStatus.active,
        roles: { some: { roleId: superRoleId, role: { status: CommonStatus.active } } },
      },
    });
    if (count < 1) throw new AppError(ERROR_CODES.CONFLICT, 'At least one enabled super_admin must remain.');
  }

  private async hashPassword(password: string) {
    try {
      return await this.passwordHashes.hash(password);
    } catch (error) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, error instanceof Error ? error.message : 'Invalid password.');
    }
  }

  private async serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (!isTransactionConflict(error) || attempt === MAX_TRANSACTION_ATTEMPTS) {
          if (isTransactionConflict(error)) throw new AppError(ERROR_CODES.CONFLICT, 'Administrator changed concurrently; retry the request.');
          throw error;
        }
      }
    }
    throw new AppError(ERROR_CODES.CONFLICT, 'Administrator changed concurrently; retry the request.');
  }
}

function toSafeDto(record: SafeUserRecord) {
  const session = record.sessions[0];
  return {
    id: record.id,
    username: record.username,
    email: record.email,
    status: record.status,
    roles: record.roles.map((entry) => safeRole(entry.role)),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastLoginAt: record.lastLoginAt,
    lastSessionActivityAt: session?.lastUsedAt ?? session?.createdAt ?? null,
  };
}

function safeRole(role: { id: string; code: string; name: string; status: CommonStatus }) {
  return { id: role.id, code: role.code, name: role.name, status: role.status };
}

function auditSnapshot(record: SafeUserRecord) {
  return {
    id: record.id,
    username: record.username,
    email: record.email,
    status: record.status,
    roleIds: record.roles.map((entry) => entry.role.id).sort(),
    roleCodes: record.roles.map((entry) => entry.role.code).sort(),
  };
}

function changedAdminFields(before: SafeUserRecord, after: SafeUserRecord): string[] {
  const fields: string[] = [];
  if (before.email !== after.email) fields.push('email');
  if (before.status !== after.status) fields.push('status');
  if (!sameSet(before.roles.map((entry) => entry.role.id), after.roles.map((entry) => entry.role.id))) fields.push('roles');
  return fields;
}

function auditActor(actor: Actor) {
  return {
    actorUserId: actor.userId,
    actorRole: actor.roleCode,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  };
}

async function revokeSessions(tx: Prisma.TransactionClient, adminUserId: string) {
  await tx.adminSession.updateMany({ where: { adminUserId, revokedAt: null }, data: { revokedAt: new Date() } });
}

function parseStatus(value: unknown, field: string): CommonStatus {
  if (value === CommonStatus.active || value === CommonStatus.disabled) return value;
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be active or disabled.`);
}

function requiredUsername(value: unknown): string {
  if (typeof value !== 'string') throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'username must be a string.');
  const username = value.trim();
  if (username.length < 3 || username.length > 64 || !/^[A-Za-z0-9._-]+$/.test(username)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'username must be 3-64 characters using letters, digits, dot, underscore, or hyphen.');
  }
  return username;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'email must be a string.');
  const email = value.trim().toLowerCase();
  if (email.length > 255 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'email must be a valid email address.');
  }
  return email;
}

function requiredPassword(value: unknown): string {
  if (typeof value !== 'string') throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'password must be a string.');
  return value;
}

function uniqueRoleIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'At least one role must be assigned.');
  }
  const ids = value.map((item) => parseUuid(item, 'roleIds'));
  if (new Set(ids).size !== ids.length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'roleIds must not contain duplicates.');
  return ids;
}

function parseUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must contain valid UUID values.`);
  return value;
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a string.`);
  const text = value.trim();
  if (!text || text.length > maxLength) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be 1-${maxLength} characters.`);
  return text;
}

function positiveInteger(value: unknown, field: string, defaultValue: number, max: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be an integer between 1 and ${max}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be an integer between 1 and ${max}.`);
  return parsed;
}

function rejectUnknownKeys(value: object, allowed: string[], location: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Unknown ${location} fields: ${unknown.join(', ')}.`);
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function isTransactionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

function translateWriteError(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = Array.isArray(error.meta?.target) ? error.meta?.target.join(',') : String(error.meta?.target ?? 'unique field');
    if (target.includes('email')) return new AppError(ERROR_CODES.DUPLICATE_RESOURCE, 'Email is already used by another administrator.');
    if (target.includes('username')) return new AppError(ERROR_CODES.DUPLICATE_RESOURCE, 'Username already exists.');
    return new AppError(ERROR_CODES.DUPLICATE_RESOURCE, 'Administrator already exists.');
  }
  return error;
}
