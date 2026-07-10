import { PrismaClient } from '@prisma/client';
import { formatAdminProvisionResult, provisionAdmin, redactCliError } from '../apps/api/src/auth/admin-provisioning';
import { PasswordHashService } from '../apps/api/src/auth/password-hash.service';

const prisma = new PrismaClient();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const password = process.env.ADMIN_PASSWORD?.trim() ?? '';
  try {
    if (!password) throw new Error('ADMIN_PASSWORD is required.');
    const result = await provisionAdmin(prisma, new PasswordHashService(), {
      username: required('ADMIN_USERNAME'),
      email: required('ADMIN_EMAIL').toLowerCase(),
      password,
      roleCode: process.env.ADMIN_ROLE?.trim() || 'super_admin',
      updateMode: process.env.ADMIN_UPDATE === 'true',
    });
    console.log(formatAdminProvisionResult(result));
  } catch (error) {
    console.error(redactCliError(error, password));
    process.exitCode = 1;
  }
}

main()
  .catch(() => {
    console.error('Admin creation failed.');
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
