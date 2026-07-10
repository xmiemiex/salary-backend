# RBAC 权限底座

## 权限点

权限点定义在 `packages/shared/src/permissions.ts` 和 `prisma/seed.ts`：

- `api_config.manage`
- `employee.manage`
- `sub_id_mapping.manage`
- `card_binding.manage`
- `income.import`
- `manual_card_spend.manage`
- `card_provider_fee_rate.manage`
- `monthly_exchange_rate.manage`
- `historical_negative_profit.manage`
- `performance_group.manage`
- `salary_item_config.manage`
- `salary_manual_item.manage`
- `settlement.generate`
- `settlement.recalculate`
- `settlement.lock`
- `settlement.unlock`，第一版默认不开放给业务角色。
- `salary.view_self`
- `salary.view_all`
- `salary.export`
- `audit_log.view`
- `audit_log.export`
- `role.manage`
- `user.manage`

## 角色

- `super_admin`：全权限，包含 `settlement.unlock`。
- `finance_manager`：财务主管，能管理结算输入、生成、重算、锁定、查看和导出审计。
- `finance`：财务，能导入收入、维护财务输入项、查看和导出工资。
- `operations_manager`：运营主管，能管理员工归属、SUB 映射、卡绑定和业绩分组。
- `employee`：只能查看本人薪资。
- `audit_viewer`：只读审计和薪资汇总。

## 服务层要求

后续每个写接口必须先做认证，再做权限检查，再做锁账检查，最后执行业务写入和审计。
