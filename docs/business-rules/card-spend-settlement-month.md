# 虚拟卡花费归属月份规则

## 核心规则

`card_spend_events.transaction_at` 是虚拟卡消费发生时间，来自 Airwallex / PhotonPay 等服务商的交易时间。`card_spend_events.settlement_month` 必须由 `transaction_at` 按 GMT+8 判断消费发生月份后得到，并保存为该月 1 日。

`card_spend_events.settled_at` 是成功结算时间，只用于状态追踪、排查和审计；它不决定工资结算归属月份。

例子：

- `2026-01-28` 消费。
- `2026-02-03` 变成 settled / 已结算。
- `2026-02-10` 拉取。
- 费用计入 `2026-01` 工资结算，不计入 `2026-02`。

## 状态映射

`card_spend_events.source_status` 保存服务商原始状态，例如 `pending`、`settled`、`cancel`、`failed`、`已结算`。

Airwallex 只计算 settled 的费用。PhotonPay 只计算 Settle status = 已结算 的费用。服务商已结算状态由 API 同步逻辑映射为 `status = confirmed` 后，才允许进入工资结算。`pending`、`cancel`、`failed` 不进入结算。

## pending 延迟 settled

API 同步必须以 `provider + external_event_id` 作为幂等键。初次拉取为 `pending` 时，可以保存为 `draft` 或暂不创建 confirmed 记录。后续同一 `external_event_id` 变为 `settled` / `已结算` 时，必须更新同一条 `card_spend_events`：

- `source_status`
- `source_updated_at`
- `settled_at`
- `status = confirmed`
- `settlement_month` 继续使用 `transaction_at` 按 GMT+8 计算得到的月份

后续变为 `cancel` / `failed` 时，不得进入 `confirmed`。

## 锁账后的迟到交易

工资结算通常在次月 15 号。上月虚拟卡花费通常在次月 10 号左右拉取，因为 pending 交易可能几天后才变成 settled 或 cancel。

如果某笔交易在锁账后才变成 settled / 已结算，且按 `transaction_at` 计算出的 `settlement_month` 属于已锁月份，不能直接修改锁定月份的结算输入或结果。API 同步任务需要调用 `MonthLockService` 或等价锁账检查，避免反写锁定月份影响工资结果。迟到费用只能在后续未锁月份通过调整项处理。

当前 `external_event_id` 在 schema 中允许为空，但 API 同步导入时必须提供。由于 PostgreSQL 唯一约束允许多个 NULL，手动或异常数据不得绕过 `provider + external_event_id` 的幂等规则。
