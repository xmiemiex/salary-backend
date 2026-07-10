# 数据库基础迁移与既有库 baseline

## 迁移职责审计

迁移链按以下边界生成，基础迁移不预先创建后续迁移负责的对象：

| 迁移 | enum | 表/列 | 索引 | 外键 |
| --- | --- | --- | --- | --- |
| `20260618000000_add_sync_tasks` | `SyncTaskSourceType`、`SyncTaskType`、`SyncTaskPlatform`、`SyncTaskStatus` | 新建 `sync_tasks` | `settlement_month + task_type`、`platform + status`、`affiliate_account_id` | `sync_tasks.affiliate_account_id -> affiliate_accounts.id`（删除时置空） |
| `20260619000000_add_api_credentials` | 无 | 新建 `affiliate_account_credentials`、`card_provider_credentials` | `affiliate_account_id` 唯一、`provider` 唯一 | `affiliate_account_credentials.affiliate_account_id -> affiliate_accounts.id` |
| `20260619010000_add_card_spend_event_imported_by` | 无 | 向 `card_spend_events` 增加 `amount`、`currency`、`imported_by` | 无 | 无 |
| `20260619020000_add_sync_unmatched_events` | `SyncUnmatchedEventStatus` | 新建 `sync_unmatched_events` | `(settlement_month, source_type, status)`、`sync_task_id`、`affiliate_account_id`、`provider`、`third_party_event_id`，以及 `(source_type, task_type, third_party_event_id)` 唯一索引 | 分别关联 `affiliate_accounts.id`、`sync_tasks.id`、`employees.id`，删除时均置空 |
| `20260621000000_align_migration_chain_with_schema` | 无 | 删除四个后续表 `id` 列上与 `@default(uuid())` 不一致的数据库端 `gen_random_uuid()` 默认值 | 将 PostgreSQL 自动截断的超长唯一索引名改为 Prisma schema 期望名称 | 无 |

`20260617000000_initial_schema` 由当前 `schema.prisma` 的临时副本生成。生成前从副本中精确移除了上表中的四组 enum、模型、关系字段和 `card_spend_events` 后增列，然后使用 `prisma migrate diff --from-empty --to-schema-datamodel` 生成 SQL，并按 enum、表、索引、外键的依赖顺序复核。

基础迁移包含后续迁移依赖的 `CommonStatus`、`SettlementStatus`、`AttendanceStatus`、`SalaryItemType`、`SalaryMode`、`Provider`、`AuditResult`，以及员工、联盟账户、Sub ID 映射、卡绑定、收入、基础卡消费、手工卡消费、月度服务商费率、汇率、历史负毛利、绩效分组、工资手动项、月度结算及明细、审计日志和 RBAC 基础表。

基础迁移明确不包含 `sync_tasks`、两个 API credential 表、`card_spend_events.amount/currency/imported_by`、`sync_unmatched_events`，也不包含它们对应的 enum、索引和外键。

末尾的对齐迁移是空库实测 diff 后的必要修正：既有迁移手写的数据库端 UUID 默认值与 Prisma 的客户端 `uuid()` 默认语义不同，且 PostgreSQL 对一个超长索引名的自动截断结果与 Prisma 期望名称不同。该迁移不增加业务对象，也不修改业务字段定义。

## 已有数据库的安全处理

以下流程只适用于已经拥有完整旧基础结构，且原后续四个迁移均已记录为 applied 的数据库。不要直接在这类数据库执行新增 initial migration SQL，否则会因对象已存在而失败，并可能放大人为误操作风险。

1. 完整备份数据库，并验证备份可恢复。
2. 核对实际 enum、表、列、索引和外键与 `20260617000000_initial_schema/migration.sql` 一致；同时确认原后续四个迁移在 `_prisma_migrations` 中均成功 applied。
3. 在明确指向该数据库的 `DATABASE_URL` 下，仅将基础迁移标记为已应用：

   ```powershell
   pnpm exec prisma migrate resolve --applied 20260617000000_initial_schema
   ```

4. 再执行：

   ```powershell
   pnpm exec prisma migrate deploy
   ```

不要把 `migrate resolve` 写入应用启动脚本或部署脚本。结构核对不通过时，应先停止部署并查明漂移原因，不能用 `resolve` 掩盖差异。
