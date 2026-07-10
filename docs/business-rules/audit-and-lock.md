# 审计与锁账设计

## AuditService

`apps/api/src/audit/audit.service.ts` 提供：

- `success(input)`：记录成功写操作。
- `failure(input)`：记录失败操作，尤其是敏感失败。
- `write(input)`：统一落 `audit_logs`。

必须审计的动作：

- 导入。
- 导出。
- 生成结算。
- 重新生成结算。
- 锁定月份。
- 尝试解锁。
- 越权失败。
- 修改锁定月份失败。
- 业务写操作成功。
- 敏感业务写操作失败。

`audit_logs` 字段包括 actor、角色、动作、对象、月份、变更前后 JSON、变更字段、请求载荷、结果、失败原因、IP、UA 和创建时间。

## MonthLockService

`apps/api/src/month-lock/month-lock.service.ts` 提供：

- `isLocked(settlementMonth)`：判断月份是否锁账。
- `assertWritable(write, actor)`：写操作前校验，锁定则写失败审计并抛 `MONTH_LOCKED`。
- `lockMonth(settlementMonth, actor, lockReason)`：写入 `monthly_settlements.status=locked`、`locked_at`、`locked_by`、`lock_reason`，并写成功审计。
- `unlockMonth()`：第一版直接拒绝。

必须接入锁账的模块：

- 手动收入。
- API 同步收入归属结果。
- Airwallex / PhotonPay 已结算虚拟卡花费归属结果。
- 手动虚拟卡花费。
- 服务商月度手续费比例。
- 月度汇率。
- 历史负毛利，金额单位为 USD，用于抵扣后续毛利 USD。
- 月度业绩分组。
- 月度工资手动项。
- 会影响该月份的 SUB ID 映射。
- 会影响该月份的虚拟卡绑定。
- 月度结算结果。
- 结算详情快照。

## 虚拟卡延迟结算与锁账

Airwallex / PhotonPay API 同步虚拟卡事件时，必须按 `external_event_id` 更新同一条 `card_spend_events`，不能重复创建。初次拉取为 `pending` 时，可以保存为 `draft` 或暂不进入 `confirmed`；后续同一外部交易变为 `settled` / `已结算` 时，更新同一条记录的 `source_status`、`source_updated_at`、`settled_at` 和 `status = confirmed`。`settlement_month` 仍然保持按 `transaction_at` 的 GMT+8 月份计算，不随 `settled_at` 改变。

如果交易在月份锁账后才变成已结算，且它按 `transaction_at` 归属的 `settlement_month` 已锁定，API 同步任务必须调用 `MonthLockService` 或等价锁账检查，不能反写锁定月份并影响已锁工资结果。该迟到费用只能在后续未锁月份通过调整项处理，并保留审计记录说明原始交易月份与调整月份。
