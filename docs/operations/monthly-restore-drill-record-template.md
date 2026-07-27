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
| Encryption format/version |  |
| Key path/owner/group/mode（不得记录 key） |  |
| Compression/encryption order |  |
| Checksum target | ciphertext / 待确认 |
| Checksum result | Pass / Warning / Fail / 未执行 |
| Authenticated decrypt result | Pass / Warning / Fail / 未执行 |
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

## 任务90已完成演练记录（非模板默认值）

| 字段 | 任务90实际值 |
| --- | --- |
| Drill ID / record ID | `task90-restore-20260727T131032Z` / `71f06ac2-bcea-44af-a182-339a38df0556` |
| 执行时间 | `2026-07-27T13:10:32Z`；duration=4s |
| Source backup | `postgres-full-20260727T131031Z.sql.gz.enc`；18,087 bytes |
| SHA-256 | `8b5020ad2d7f95f238e4f6010f47d6605e58d829928019dbfaeb46338048b146`；ciphertext sidecar match |
| 加密/压缩 | `aes-256-gcm-v1`；gzip-before-encryption；认证解密 Pass；gzip Pass |
| Key | `/etc/salary-settlement-admin/backup-file-encryption.key`；`root:root`、`0600`；未记录 key |
| Isolation | 唯一 container + volume；PostgreSQL 16；`network=none`；host port=none |
| 生产接触 | production database contacted=`no`；destructive to primary=`false`；生产 `.env` 未传入 |
| 非敏感验证 | server=`160014`；database=2；role=2；schema=2；table=33；finished migration=17 |
| 业务数据输出 | `no` |
| Cleanup | container/volume/临时日志均清理；独立复核无 `task90.restore=true` 资源残留 |
| 生产后检 | Nginx/Docker/PostgreSQL active；failed units=0；API/Web healthy、restart=`0/0`；全部入口 Pass |
| Evidence | BackupRecord/RestoreDrillRecord 及各一条成功审计均经独立只读查询匹配 |
| Result | **Pass** |
