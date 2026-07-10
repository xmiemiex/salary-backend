import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { AuthConfigService } from './auth-config.service';
import { Actor, ChangePasswordInput, LoginInput } from './auth.types';
import { PasswordHashService } from './password-hash.service';

const USER_INCLUDE = {
  roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
} satisfies Prisma.AdminUserInclude;

const DUMMY_PASSWORD_HASH = `scrypt-v1$N=16384,r=8,p=1$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(64).toString('base64url')}`;
const CURRENT_PASSWORD_ERROR = 'Current password is incorrect.';
const SESSION_LIMIT = 100;
const USER_AGENT_LIMIT = 512;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordHashes: PasswordHashService,
    private readonly config: AuthConfigService,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginInput, context: { ipAddress?: string; userAgent?: string }) {
    const username = typeof input?.username === 'string' ? input.username.trim() : '';
    const password = typeof input?.password === 'string' ? input.password : '';
    const user = username && username.length <= 64 && password.length <= 256
      ? await this.prisma.adminUser.findUnique({ where: { username }, include: USER_INCLUDE })
      : null;
    const verified = await this.passwordHashes.verify(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    const passwordMatches = Boolean(user) && verified;
    const activeRoles = user?.roles.map((entry) => entry.role).filter((role) => role.status === CommonStatus.active) ?? [];

    if (!user || !passwordMatches || user.status !== CommonStatus.active || activeRoles.length === 0) {
      await this.audit.failure({
        actorUserId: user?.id,
        actorRole: activeRoles[0]?.code,
        action: 'auth.login', objectType: 'admin_session',
        failureReason: 'invalid_credentials', ...context,
      });
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Invalid username or password.');
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + this.config.sessionTtlHours * 60 * 60 * 1000);
    const actor = this.toActor(user, activeRoles, context);

    await this.prisma.$transaction(async (tx) => {
      const session = await tx.adminSession.create({ data: {
        adminUserId: user.id, tokenHash, expiresAt,
        ipAddress: context.ipAddress?.slice(0, 64), userAgent: context.userAgent?.slice(0, USER_AGENT_LIMIT),
      } });
      await tx.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await this.audit.success({
        actorUserId: user.id, actorRole: actor.roleCode,
        action: 'auth.login', objectType: 'admin_session', objectId: session.id, ...context,
      }, tx);
    });
    return { token, expiresAt: expiresAt.toISOString(), actor };
  }

  async logout(sessionId: string, actor: Actor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.adminSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.success({
        actorUserId: actor.userId, actorRole: actor.roleCode,
        action: 'auth.logout', objectType: 'admin_session', objectId: sessionId,
        ipAddress: actor.ipAddress, userAgent: actor.userAgent,
      }, tx);
    });
  }

  async getSecurity(adminUserId: string) {
    const user = await this.prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: {
        username: true, email: true, status: true, lastLoginAt: true,
        roles: { select: { role: { select: { id: true, code: true, name: true, status: true } } }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!user) throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Invalid authorization token.');
    return {
      username: user.username,
      email: user.email,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      roles: user.roles.map(({ role }) => role),
    };
  }

  async changePassword(input: ChangePasswordInput, actor: Actor) {
    this.rejectUnknownKeys(input, ['currentPassword', 'newPassword', 'confirmPassword']);
    const currentPassword = this.requirePasswordString(input.currentPassword, 'currentPassword');
    const newPassword = this.requirePasswordString(input.newPassword, 'newPassword');
    if (input.confirmPassword !== newPassword) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Password confirmation does not match.');
    }
    try {
      this.passwordHashes.validate(newPassword);
    } catch (error) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, error instanceof Error ? error.message : 'Invalid password.');
    }

    const user = await this.prisma.adminUser.findUnique({ where: { id: actor.userId }, select: { passwordHash: true } });
    if (!user || !(await this.passwordHashes.verify(currentPassword, user.passwordHash))) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, CURRENT_PASSWORD_ERROR);
    }
    if (await this.passwordHashes.verify(newPassword, user.passwordHash)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'New password must be different from the current password.');
    }
    const passwordHash = await this.passwordHashes.hash(newPassword);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.adminUser.updateMany({
        where: { id: actor.userId, passwordHash: user.passwordHash },
        data: { passwordHash },
      });
      if (updated.count !== 1) throw new AppError(ERROR_CODES.CONFLICT, 'Password changed concurrently. Retry the request.');
      const revoked = await tx.adminSession.updateMany({
        where: { adminUserId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date() },
      });
      await this.audit.success({
        actorUserId: actor.userId, actorRole: actor.roleCode,
        action: 'auth.change_password', objectType: 'admin_user', objectId: actor.userId,
        changedFields: ['password'], afterData: { sessionsRevoked: revoked.count },
        ipAddress: actor.ipAddress, userAgent: actor.userAgent,
      }, tx);
      return { success: true };
    });
  }

  isCurrentPasswordError(error: unknown): boolean {
    return error instanceof AppError && error.message === CURRENT_PASSWORD_ERROR;
  }

  async listSessions(adminUserId: string, currentSessionId: string) {
    const now = new Date();
    const sessions = await this.prisma.adminSession.findMany({
      where: { adminUserId, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true, createdAt: true, expiresAt: true, lastUsedAt: true, ipAddress: true, userAgent: true },
      orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: SESSION_LIMIT,
    });
    return sessions.map((session) => ({
      ...session,
      ipAddress: maskIpAddress(session.ipAddress),
      userAgent: session.userAgent?.slice(0, USER_AGENT_LIMIT) ?? null,
      isCurrent: session.id === currentSessionId,
    }));
  }

  async revokeSession(id: string, currentSessionId: string, actor: Actor) {
    if (!isUuid(id)) return { success: true, currentSessionRevoked: false };
    const session = await this.prisma.adminSession.findUnique({
      where: { id },
      select: { adminUserId: true, revokedAt: true, expiresAt: true },
    });
    if (session && session.adminUserId !== actor.userId && session.revokedAt === null && session.expiresAt > new Date()) {
      await this.audit.failure({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'auth.session_revoke_denied',
        objectType: 'admin_session',
        objectId: id,
        failureReason: ERROR_CODES.PERMISSION_DENIED,
        errorMessage: 'Cannot revoke another administrator session.',
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'Permission denied.');
    }
    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.adminSession.updateMany({
        where: { id, adminUserId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date() },
      });
      if (revoked.count > 0) {
        await this.audit.success({
          actorUserId: actor.userId, actorRole: actor.roleCode,
          action: 'auth.session_revoke', objectType: 'admin_session', objectId: id,
          afterData: { sessionsRevoked: 1 }, ipAddress: actor.ipAddress, userAgent: actor.userAgent,
        }, tx);
      }
      return { success: true, currentSessionRevoked: revoked.count > 0 && id === currentSessionId };
    });
  }

  async logoutAll(actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.adminSession.updateMany({
        where: { adminUserId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date() },
      });
      await this.audit.success({
        actorUserId: actor.userId, actorRole: actor.roleCode,
        action: 'auth.logout_all', objectType: 'admin_user', objectId: actor.userId,
        afterData: { sessionsRevoked: revoked.count }, ipAddress: actor.ipAddress, userAgent: actor.userAgent,
      }, tx);
      return { success: true };
    });
  }

  private rejectUnknownKeys(input: object, allowed: string[]) {
    const unknown = Object.keys(input ?? {}).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Unknown body fields: ${unknown.join(', ')}.`);
  }

  private requirePasswordString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length > 256) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a string no longer than 256 characters.`);
    }
    return value;
  }

  private toActor(user: Prisma.AdminUserGetPayload<{ include: typeof USER_INCLUDE }>, activeRoles: Array<(typeof user.roles)[number]['role']>, context: { ipAddress?: string; userAgent?: string }): Actor {
    return {
      userId: user.id,
      roleCode: activeRoles[0].code,
      permissions: Array.from(new Set(activeRoles.flatMap((role) => role.permissions.map((entry) => entry.permission.code)))).sort(),
      employeeId: user.employeeId ?? undefined,
      ...context,
    };
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function maskIpAddress(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.');
    return `${parts[0]}.${parts[1]}.*.*`;
  }
  if (value.includes(':')) return `${value.split(':').slice(0, 3).join(':')}:*`;
  return value.slice(0, 64);
}
