import { CommonStatus, Prisma, PrismaClient } from '@prisma/client';
import { PasswordHashService } from './password-hash.service';

export type AdminProvisionInput = {
  username: string;
  email: string;
  password: string;
  roleCode: string;
  updateMode: boolean;
};

export type AdminProvisionResult = {
  id: string;
  username: string;
  updated: boolean;
};

type TransactionHost = Pick<PrismaClient, '$transaction'>;

export function validateAdminProvisionInput(input: AdminProvisionInput): void {
  if (!input.username || input.username.length > 64) throw new Error('ADMIN_USERNAME is required and must not exceed 64 characters.');
  if (!input.email || input.email.length > 255 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) {
    throw new Error('ADMIN_EMAIL must be a valid email address.');
  }
  if (!input.roleCode) throw new Error('ADMIN_ROLE must not be empty.');
}

export async function provisionAdmin(
  prisma: TransactionHost,
  passwordHashes: PasswordHashService,
  input: AdminProvisionInput,
): Promise<AdminProvisionResult> {
  validateAdminProvisionInput(input);
  const passwordHash = await passwordHashes.hash(input.password);

  return prisma.$transaction(async (tx) => {
    const role = await tx.role.findUnique({ where: { code: input.roleCode } });
    if (!role || role.status !== CommonStatus.active) {
      throw new Error(`Active role '${input.roleCode}' does not exist. Run pnpm prisma:seed first.`);
    }

    const [byUsername, byEmail] = await Promise.all([
      tx.adminUser.findUnique({ where: { username: input.username } }),
      tx.adminUser.findUnique({ where: { email: input.email } }),
    ]);
    if (byEmail && byEmail.id !== byUsername?.id) throw new Error(`ADMIN_EMAIL '${input.email}' is already used by another user.`);
    if (byUsername && !input.updateMode) {
      throw new Error(`ADMIN_USERNAME '${input.username}' already exists. Set ADMIN_UPDATE=true for an explicit update.`);
    }

    if (!byUsername) {
      const user = await tx.adminUser.create({
        data: {
          username: input.username,
          email: input.email,
          passwordHash,
          displayName: input.username,
          status: CommonStatus.active,
          roles: { create: { roleId: role.id } },
        },
      });
      return { id: user.id, username: user.username, updated: false };
    }

    const revokedAt = new Date();
    const user = await tx.adminUser.update({
      where: { id: byUsername.id },
      data: { email: input.email, passwordHash, status: CommonStatus.active },
    });
    await tx.adminUserRole.deleteMany({
      where: { adminUserId: user.id, roleId: { not: role.id } },
    });
    await tx.adminUserRole.upsert({
      where: { adminUserId_roleId: { adminUserId: user.id, roleId: role.id } },
      update: {},
      create: { adminUserId: user.id, roleId: role.id },
    });
    await tx.adminSession.updateMany({
      where: { adminUserId: user.id, revokedAt: null },
      data: { revokedAt },
    });
    return { id: user.id, username: user.username, updated: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export function redactCliError(error: unknown, password: string): string {
  const message = error instanceof Error ? error.message : 'Admin creation failed.';
  return password ? message.split(password).join('[REDACTED]') : message;
}

export function formatAdminProvisionResult(result: AdminProvisionResult): string {
  return `Admin user ${result.updated ? 'updated' : 'created'}: username=${result.username} id=${result.id}`;
}
