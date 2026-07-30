# 生产只读监控运行手册

本手册用于任务85及其后续生产复核。除按
[备份与恢复 SOP](backup-and-restore-sop.md) 执行已安装的日常健康检查和另行批准的隔离
恢复外，它不授权部署、重启、切流、migration、业务数据写入、账号/权限修改、告警变更、
备份手动触发或 RC tag 变更。

当前生产状态：**Full Go stable with accepted backup risk**。最终 release gate：**`37 pass / 0 warning / 0 fail`**，exit=`0`。无异机备份风险已阶段性接受但仍未解决。

本机备份的长期日常检查、失败处理和月度隔离恢复演练以 [PostgreSQL 本机备份与隔离恢复演练 SOP](backup-and-restore-sop.md) 为准；风险状态以 [生产风险台账](production-risk-register.md) 为准。

## 任务85历史检查点

任务85不再执行 T+1/T+6/T+12，也不补跑，只保留 T+24 最终复核。

| 标签 | 观察窗口 | 计划时间（Asia/Shanghai） | 状态 |
| --- | --- | --- | --- |
| `t24h` | 最近24小时 | `2026-07-25 20:20` | **已完成 / Warning**；`Full Go Regression` |

## 自动化执行边界

- SSH：Tailscale `100.103.6.23`，用户 `salaryops`，本机既有 key `salary_do_ed25519_v2`
- 脚本：`/home/salaryops/task85-post-go-check.sh`
- helper：`/home/salaryops/task85-helper.js`
- 参数：`t24h no-audit`
- sudo：只允许用户在可见 SSH 窗口交互输入
- 输出：`/opt/salary-settlement-admin/evidence/task85-post-go/<label>-<UTC timestamp>`
- 可读摘要：`/home/salaryops/task85-latest-summary.env`

不要把 sudo 密码、管理员密码、token、session、cookie、bearer、数据库 URL、secret 或 private key 放进聊天、脚本参数或文档。不要读取生产 `.env` 原文。

## T+24 验收

- Nginx、Docker、PostgreSQL active；failed units=0
- API/Web running、healthy、restart=0
- Admin/API live/API ready HTTPS 200，TLS verify=0
- Nginx target 为授权 RC
- PostgreSQL public listeners=0
- 最近24小时 Nginx/API/Web/PostgreSQL error 和 HTTP 5xx 统计完整、无阻断异常
- critical alerts=0
- release gate 无 fail；任何 warning 必须记录 code
- env check Pass；migration expected/applied=17/17、pending=0、drift=false
- backup timer active/enabled；latest full backup 在72小时内
- restore drill 在90天内
- active admin/super_admin/low-privilege=`1/1/0`
- 任务84临时账号 disabled、active=0、active sessions=0
- audit export smoke 完成；如需管理员凭据，可标记 Pending 或由用户仅在可见 SSH 窗口输入
- permissions=37
- 磁盘与内存未达阻断阈值
- evidence 敏感值扫描为 0

## 异常处理

脚本退出非零时，先区分生产异常与监控脚本异常。生产异常必须标记 `Post-Go Incident Risk`，说明是否建议人工回滚；未经另行授权不自动回滚。监控脚本异常必须保存失败点并修复脚本后只读重跑，不能把脚本失败冒充生产故障，也不能用脚本缺陷掩盖真实故障。

T+24 若仅因任务84真实 403 evidence 超过24小时而出现 `E2E_PERMISSIONS_RECENT_RUN` warning，记录为 `Full Go Regression`。数据库计数、账号 disabled 状态或人为改时间戳都不能替代新的真实低权 403 smoke。全部通过时状态改为 `Full Go stable with accepted backup risk`；出现任何 warning/fail 时，如实记录并明确是否建议返修或人工回滚，但不自动回滚。

## 长期技术债

1. 进入正式长期运营前单独复核无异机备份风险；是否建设异机备份须另行决策和授权，当前不实施、不采购、不配置。
2. 建立正式、受控、可审计的低权测试账号策略。
3. 建立长期监控告警 SOP，包括升级、值班、确认、恢复和复盘。
4. 每月执行隔离 restore drill，并保留至少90天内的可信证据。
5. 定期清理/归档 release gate evidence，避免超龄证据被误用。
6. 周期性抽检生产审计导出，仅保留脱敏计数与受控 evidence。
7. 固化依赖升级和安全补丁节奏。
8. 如后续需要业务数据导入/初始化，先设计幂等、审计、回滚和审批流程。
9. 任务89的物理 backup record 不同步已由任务90真实修复并关闭。后续若 recorder 失败、
   最新加密 record 超龄、认证解密失败或 backup gate 失败，立即重新打开 RISK-DP-002，
   不得降低门禁或伪造 Evidence。
10. 本机 encryption key 丢失风险记录为 RISK-DP-003；当前只有 root-only 权限、指纹检查和
    恢复演练缓解，尚未完成异机密钥托管。

## Task90 日常操作

每日只读健康检查：

```bash
sudo /usr/local/sbin/check-local-backup-health
```

预期 `TASK88_BACKUP_HEALTH_STATUS=pass`、warning/failure codes=`none`。健康检查验证
ciphertext sidecar、GCM 认证解密、gzip、权限、age、service/timer、retention 和磁盘。

Evidence 自动同步发生在每日备份 service 内。若物理密文已成功但 recorder 失败，先保留
密文并处理根因，再按同一绝对路径重放：

```bash
sudo /usr/local/sbin/record-backup-evidence \
  /opt/salary-settlement-admin/backups/postgres-full-<UTC>.sql.gz.enc
```

成功重放应返回 `created` 或已有完全一致记录的 `no_change`；conflict 必须升级，不得覆盖。
月度恢复使用 `/usr/local/sbin/restore-encrypted-backup`，严格条件和记录字段见 SOP 与模板。

任务90生产基线：最新密文 `postgres-full-20260727T131031Z.sql.gz.enc`，BackupRecord/
RestoreDrillRecord 均匹配；release gate exit=0、`34/3/0`，备份相关门禁全部 Pass。
三个 warning 为 `E2E_PERMISSIONS_RECENT_RUN`、`ENV_CHECK_AVAILABLE`、
`MIGRATIONS_UP_TO_DATE`，不得写成全绿，也不影响本次备份修复真实性。最终 API/Web
restart=`0/0`，active critical alerts=0。

## Task91 Release Gate 标准入口

生产唯一标准入口为：

```bash
sudo /home/salaryops/production-release-gate.sh
```

该入口固定使用已部署 RC `rc-20260712-2-9f8f8f57` 和生产 `.env`，但不输出 `.env`
原文。每次运行先执行 23 项脱敏 production env check，再用 RC 的
`prisma/migrations` 与生产 `_prisma_migrations` 做只读名称、完成状态和 checksum
比较；两份新 Evidence 与既有真实权限 E2E Evidence 统一放在
`/opt/salary-settlement-admin/evidence/release-gate-current`，Gate 只读挂载该目录。
完整脱敏 Gate JSON 归档在受限的 `release-gate-runs` 目录，并复制到
`/home/salaryops/release-gate-latest.json` 供运维复核。

权限 Evidence 超过 24 小时时不得复制旧时间戳或用数据库计数替代。经明确授权后运行：

```bash
sudo /home/salaryops/production-permissions-smoke.sh
```

该脚本只复用既有 disabled 的 `task84_permission_smoke` 和唯一
`salary.view_self` 最小角色，不创建账号或角色，不修改角色。它验证未认证 401、
super_admin 权限链、真实低权登录与 `/me`、release gate run 403、管理员接口 403 和
logout-all，最后恢复账号 disabled、撤销临时 session，并写入新的真实 production
Evidence。super_admin 凭据只允许在可见 SSH 会话交互输入。

任务91最终生产 Gate generatedAt=`2026-07-28T14:09:08.370Z`：
`37 pass / 0 warning / 0 fail`，required/recommended fail/warning code 均为 none。
env check=`23/23`；migration=`17/17`、pending=`0`、drift=`false`；权限 smoke=`7/7`。
最新加密 full backup age=`11h`，backup health Pass，restore drill age=`1d`。

## Task93 每日加密备份独立告警闭环

标准状态检查：

```bash
systemctl is-enabled salary-postgres-backup-watchdog.timer
systemctl is-active salary-postgres-backup-watchdog.timer
systemctl show salary-postgres-backup-watchdog.service \
  -p Result -p ExecMainStatus --no-pager
systemctl list-timers salary-postgres-backup-watchdog.timer --all --no-pager
```

预期 timer 为 enabled/active，最近 oneshot 为 success/0。timer 在每日备份窗口之后独立
运行；watchdog 的异常不得阻塞、停止或重启 `salary-postgres-backup.service`。

处置顺序：

1. 先按告警 code 只读复核 timer/service、最新密文 basename 与 sidecar、BackupRecord、
   backup health 和文件系统容量。
2. 不得通过手工 full backup、改 key、删文件/记录、改 retention 或改系统时间制造恢复。
3. 根因消失后等待下一次 timer，或受控执行
   `sudo systemctl start salary-postgres-backup-watchdog.service`。
4. 确认同 fingerprint 告警 resolved、其他 source 未变化、active critical 回到基线。
5. watchdog 自身失败时检查
   `salary-postgres-backup-watchdog-failure.service`；必要时仅 disable/stop Task93 timer，
   恢复 root-only 回滚副本并 daemon-reload。不得回滚任务90的加密备份链。

Task93 首次生产接入于 `2026-07-30T12:29:41Z–12:29:45Z` 完成。watchdog timer
enabled/active，首次 oneshot success/0；下一次计划触发为
`2026-07-31T04:03:08Z`。合成 critical 告警首次创建 1 条，第二次只更新同一 alert，
随后 resolved；active critical 为 `0 → 0`。原备份 timer 保持 enabled/active，原
service 保持 success/0，API/Web restart 保持 `0/0`。

接入后标准 Release Gate generatedAt=`2026-07-30T13:00:41.248Z`：
`36 pass / 1 warning / 0 fail`，exit=0。唯一 warning 为
`E2E_PERMISSIONS_RECENT_RUN`；没有运行 permissions smoke，也没有刷新或伪造权限
Evidence。
