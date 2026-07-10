# MonthLockService 测试用例

## 已覆盖

- 未锁账月份允许写操作。
- 已锁账月份拒绝写操作。
- 已锁账月份的失败写操作必须写入失败审计。

## 后续补充

- 锁定已锁月份返回 `SETTLEMENT_ALREADY_LOCKED`。
- 锁账成功必须写入 `locked_at`、`locked_by`、`lock_reason`。
- 解锁接口第一版默认拒绝。
- 非 `super_admin` 尝试解锁必须写失败审计。
