# 生产只读监控运行手册

本手册用于任务85及其后续只读生产复核。它不授权部署、重启、切流、migration、业务数据写入、账号/权限修改、告警变更、备份手动触发、恢复操作或 RC tag 变更。

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
