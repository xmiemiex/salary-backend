# 数据库模型设计要点

## 月份字段

所有 `settlement_month` / `effective_month` 使用 PostgreSQL `date`，约定保存每月 1 日，例如 `2026-05-01`。服务层必须把用户输入的 `YYYY-MM` 归一化为该月 1 日。

`card_spend_events.settlement_month` 是特殊业务归属字段：它必须由 `transaction_at` 按 GMT+8 的消费发生月份计算，保存为该月 1 日；不能由 `settled_at` 计算。比如 `2026-01-31T17:00:00.000Z` 在 GMT+8 已是 `2026-02-01 01:00:00`，因此归属 `2026-02-01`。

## 金额与比例

- USD / RMB 金额全部使用 Prisma `Decimal`，不使用 float。
- 汇率使用 `Decimal(18, 8)`。
- 手续费比例保存实际计算值，例如 3% 保存为 `0.03`，前端展示时格式化为 `3%`。
- 历史负毛利用于抵扣后续毛利 USD，因此 `historical_negative_profits.amount_usd` 使用 `Decimal(18, 6)`，不是 RMB。
- 手动虚拟卡花费的实际花费规则为：`actual_spend_usd = settled_spend_usd * (1 + fee_rate)`。只有 `confirmed` 状态的手动虚拟卡花费进入月度结算。

## 已落库核心表

Prisma schema 已包含：

1. `employees`
2. `affiliate_accounts`
3. `sub_id_mappings`
4. `card_bindings`
5. `income_records`
6. `card_spend_events`
7. `manual_card_spend_entries`
8. `monthly_card_provider_fee_rates`
9. `monthly_exchange_rates`
10. `historical_negative_profits`
11. `monthly_performance_groups`
12. `monthly_performance_group_members`
13. `salary_item_configs`
14. `monthly_salary_manual_items`
15. `monthly_settlements`
16. `monthly_settlement_details`
17. `audit_logs`
18. `admin_users`
19. `roles`
20. `permissions`
21. `admin_user_roles`
22. `role_permissions`

## 关键约束

- `employees.employee_code` 唯一。
- `sub_id_mappings` 对 `affiliate_account_id + sub_field + sub_value + effective_month` 唯一。
- `card_bindings` 对 `provider + card_id + effective_month` 唯一。
- `monthly_card_provider_fee_rates` 对 `settlement_month + provider` 唯一。
- `monthly_exchange_rates.settlement_month` 唯一。
- `monthly_performance_group_members` 对 `settlement_month + employee_id` 唯一。
- 同一 `monthly_performance_group` 下，成员 `allocation_ratio` 合计必须等于 `1`。该规则由服务层在写入和确认分组时校验。
- `monthly_settlements.settlement_month` 唯一。
- `monthly_settlement_details` 对 `settlement_id + employee_id` 唯一。
- 员工表不保存默认提成比例、星级、工资档位、全勤奖金额。

## 表字段修正说明

- `income_records.affiliate_account_id` 可为空，以支持其他收入手动导入；仍保留 `source`、`external_record_id`、`employee_id`、`sub_field`、`sub_value`。
- `manual_card_spend_entries` 使用 `provider_name` 和 `card_identifier`，不使用 `Provider enum`，以支持无 API 文档或临时接入的虚拟卡平台。
- `manual_card_spend_entries` 保存 `settled_spend_usd`、`fee_rate`、`actual_spend_usd` 三个字段，避免结算时字段语义混乱。
- `card_spend_events.transaction_at` 保存服务商交易发生时间，是 API 虚拟卡事件计算 `settlement_month` 的唯一时间依据。
- `card_spend_events.settled_at` 保存成功结算时间，只用于状态追踪和审计，不用于决定归属月份。
- `card_spend_events.source_status` 保存服务商原始状态，例如 Airwallex 的 `pending` / `settled` / `cancel` / `failed`，或 PhotonPay 的 `已结算` 等。只有服务商已结算状态映射为 `status = confirmed` 后才进入工资结算；`pending`、`cancel`、`failed` 不进入结算。
- `card_spend_events.external_event_id` 当前允许为空，但 API 同步导入必须提供。PostgreSQL 唯一约束允许多个 NULL，因此手动或异常数据不得绕过 `provider + external_event_id` 幂等规则。
- `historical_negative_profits` 保存 `amount_usd`，用于抵扣毛利 USD。
- `monthly_performance_group_members` 保存 `allocation_ratio`，支持 50/50、1:9 等分配比例。

## audit_logs 写保护

应用层必须只通过 `AuditService` 追加审计日志，不提供普通更新和删除入口。更强约束建议在首个正式 migration 中补 PostgreSQL trigger 或权限隔离：

- 应用业务用户撤销 `UPDATE` / `DELETE audit_logs` 权限。
- 或创建 `BEFORE UPDATE OR DELETE ON audit_logs` trigger 直接拒绝。
