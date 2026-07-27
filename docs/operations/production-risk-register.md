# 生产风险台账

## RISK-DP-001：无异机备份 / Off-host backup unavailable

| 字段 | 记录 |
| --- | --- |
| 状态 | **Accepted** |
| 风险类型 | 数据保全风险 |
| 影响 | Droplet 整机故障、磁盘损坏或同机灾难时，生产数据库和本机备份可能同时不可恢复 |
| 当前缓解措施 | 本机每日 AES-256-GCM 加密 full backup；ciphertext SHA-256 sidecar；root-only key；受限文件权限；Backup Evidence 自动同步；隔离恢复演练；每日磁盘空间检查 |
| 未实施措施 | DigitalOcean Spaces；S3；对象存储；远端或其他异机备份 |
| 接受依据 | 业务方正式声明：“当前接受无异机备份风险。本阶段仅保留本机每日备份 + 隔离恢复演练。Droplet 整机故障时存在数据不可恢复风险。后续进入正式长期运营前补异机备份。” |
| 当前是否阻断上线 | **否** |
| 当前生产状态 | `Full Go stable with accepted backup risk` |
| 未来复核触发条件 | 进入正式长期运营前单独评估 |
| 当前任务是否实施异机备份 | **否** |
| 最近复核 | 2026-07-27，任务90；仍为 Accepted / unresolved / non-blocking |

该风险尚未解决，不能写成“异机备份已完成”或“风险已消除”。未来复核是决策触发条件，
不是任务90的实施要求，也不授权当前购买、配置或推动任何对象存储。

## RISK-DP-002：物理备份与应用记录不同步

| 字段 | 记录 |
| --- | --- |
| 状态 | **Resolved / Closed（任务90，2026-07-27）** |
| 风险类型 | 监控与证据一致性 |
| 影响 | 每日物理备份成功，但应用数据库中的最近 backup record 未同步；依赖该记录的 health/release gate 可能报告超龄 |
| 任务89历史事实 | 每日 `.sql.gz` 未加密，无法真实写成 `encrypted=true`，因此保持 Open 且没有伪造记录 |
| 任务89结果 | **Blocked / no production write**：每日 `.sql.gz` 未加密；如实记录 `encrypted=false` 会触发 `backup.not_encrypted` critical，伪造 `true` 或降低检查均被禁止 |
| 任务90修复 | 每日流程改为真实 `aes-256-gcm-v1` 密文；ciphertext checksum、认证解密和 gzip 验证通过后，recorder 事务同步真实 BackupRecord |
| 关闭证据 | `postgres-full-20260727T131031Z.sql.gz.enc` 的 BackupRecord ID=`4c99b322-073e-47c3-8537-0dd055ca5b05`；幂等重放=`no_change`；backup health=`pass`；72h gate=`pass`；隔离恢复及 RestoreDrillRecord 通过 |
| Release gate | exit=0；backup checks Pass；总计 `34 pass / 3 warning / 0 fail`，三个 warning 与本风险无关 |
| 当前是否阻断运行 | 否；风险已真实修复并关闭 |
| 复发条件 | recorder 非 `created/no_change`、最新加密记录超龄、checksum/认证解密失败、backup health critical 或 backup gate fail 时立即重新打开 |
| 责任人 | Application owner + Operations owner |

## RISK-DP-003：本机备份加密密钥丢失或损坏

| 字段 | 记录 |
| --- | --- |
| 状态 | **Open / Mitigated / non-blocking** |
| 风险类型 | 密钥可用性与数据可恢复性 |
| 影响 | `/etc/salary-settlement-admin/backup-file-encryption.key` 丢失、损坏或被错误替换后，现有本机密文备份无法恢复 |
| 当前缓解 | key 为 `root:root 0600`；用途 metadata 与非敏感指纹检查；每次备份进行 crypto self-test；每日认证解密+gzip 检查；任务90真实隔离恢复 Pass |
| 未实施措施 | 异机密钥托管、HSM/KMS、经过验证的密钥恢复副本与轮换流程 |
| 当前是否阻断运行 | 否；当前 key 与最新备份已通过独立恢复验证 |
| 禁止事项 | 不得在聊天、Git、日志或命令行记录 key；不得擅自删除、覆盖或轮换 |
| 后续复核 | 与 RISK-DP-001 的异机备份/长期运营设计一并单独评估和授权 |
