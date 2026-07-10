import { PrismaClient } from '@prisma/client';
import { PERMISSIONS } from '@salary/shared';

const prisma = new PrismaClient();

const permissions = [...PERMISSIONS];

const rolePermissions: Record<string, string[]> = {
  super_admin: permissions,
  finance_manager: [
    'employee.manage',
    'income.import',
    'manual_card_spend.manage',
    'card_provider_fee_rate.manage',
    'monthly_exchange_rate.manage',
    'historical_negative_profit.manage',
    'performance_group.manage',
    'salary_item_config.manage',
    'salary_manual_item.manage',
    'settlement.generate',
    'settlement.recalculate',
    'settlement.lock',
    'salary.view_all',
    'salary.export',
    'audit_log.view',
    'audit_log.export',
  ],
  finance: [
    'income.import',
    'manual_card_spend.manage',
    'card_provider_fee_rate.manage',
    'monthly_exchange_rate.manage',
    'historical_negative_profit.manage',
    'salary_manual_item.manage',
    'salary.view_all',
    'salary.export',
  ],
  operations_manager: [
    'employee.manage',
    'sub_id_mapping.manage',
    'card_binding.manage',
    'performance_group.manage',
    'salary.view_all',
  ],
  employee: ['salary.view_self'],
  audit_viewer: ['audit_log.view', 'audit_log.export', 'salary.view_all'],
};

async function main() {
  for (const code of permissions) {
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, name: code },
    });
  }

  for (const [code, permissionCodes] of Object.entries(rolePermissions)) {
    const role = await prisma.role.upsert({
      where: { code },
      update: {},
      create: { code, name: code },
    });

    for (const permissionCode of permissionCodes) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { code: permissionCode } });
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permission.id,
        },
      });
    }
  }
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
