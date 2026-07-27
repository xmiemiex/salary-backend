# 月度隔离恢复演练记录模板

本模板不得预填成功结果。填写时只记录脱敏元数据、状态、计数和受限 evidence 引用，不粘贴原始日志、业务明细、凭据或生产 `.env`。

## 基本信息

| 字段 | 填写值 |
| --- | --- |
| Drill ID |  |
| 执行时间和时区 |  |
| 执行人 |  |
| 审核人 |  |
| Evidence reference |  |
| Sensitive values included | `no` / 待确认 |

## Source backup 与完整性

| 字段 | 填写值 |
| --- | --- |
| Source backup 标识（安全 basename） |  |
| Source backup 时间 |  |
| Backup age |  |
| Backup size（bytes / human-readable） |  |
| Expected SHA-256 |  |
| Actual SHA-256 |  |
| Checksum source |  |
| Checksum result | Pass / Warning / Fail / 未执行 |
| Compression integrity result | Pass / Warning / Fail / 未执行 |

## 隔离参数

| 字段 | 填写值 |
| --- | --- |
| Isolation method |  |
| Temporary directory |  |
| Temporary container name |  |
| Temporary volume name |  |
| Network mode |  |
| Host port bindings |  |
| Production database contacted | `no` / 待确认 |
| Destructive to primary | `no` / 待确认 |
| Source mounted read-only | yes / no / 待确认 |
| Production `.env` used | `no` / 待确认 |

## 恢复与验证

| 字段 | 填写值 |
| --- | --- |
| Restore start time |  |
| Restore finish time |  |
| Restore duration |  |
| Restore exit code |  |
| PostgreSQL version |  |
| Database startup result | Pass / Warning / Fail / 未执行 |
| Migration/table structure verification |  |
| 非敏感计数验证 |  |
| Business rows queried or exported | `no` / 待确认 |
| Errors/warnings |  |

## Cleanup 与生产后检

| 字段 | 填写值 |
| --- | --- |
| Temporary container removed | yes / no / 待确认 |
| Temporary volume removed | yes / no / 待确认 |
| Temporary directory removed | yes / no / 待确认 |
| Cleanup status | Pass / Warning / Fail / 未执行 |
| Production Nginx/Docker/PostgreSQL after drill |  |
| API/Web restart count before / after |  |
| Public Admin/API live/API ready after drill |  |
| Production service health after drill | Pass / Warning / Fail / 未执行 |

## 结论与跟进

| 字段 | 填写值 |
| --- | --- |
| Result | Pass / Warning / Fail |
| 判定依据 |  |
| Follow-up owner |  |
| Follow-up due date |  |
| 审核结论 |  |
| 审核时间和时区 |  |
