# 生产运维交接

## 当前生产状态

- 运行版本：`rc-20260712-2` / `9f8f8f576dde54355983b96525335e94c55c8b32`
- 状态：`Full Go stable with accepted backup risk`
- 入口：Admin、API live、API ready 均通过 HTTPS；API/Web 容器健康
- PostgreSQL：系统服务 active，不公网监听
- 本机备份：`salary-postgres-backup.timer` active/enabled；每日 `aes-256-gcm-v1`
  加密 full backup、ciphertext sidecar、BackupRecord 自动同步
- 已知风险：无异机备份，状态 **Accepted**、未解决、当前不阻断上线

任务85不是重新发布。任务82已完成部署/切流，任务84已完成真实低权 403 smoke 与 Full Go 转正；任务85完成 T+24 监控。任务86刷新过期的真实 production E2E/审计 evidence，并以 `37/0/0` 和 5 分钟无异常观察完成 stable 收口；同样没有重新部署、重启、切流或迁移。

## 交接入口

- 上线审批记录：`docs/release/production-approval-record.md`
- 24 小时监控报告：`docs/release/post-go-monitoring-report.md`
- 发布运行手册：`docs/release/production-runbook.md`
- 本机备份与隔离恢复 SOP：`docs/operations/backup-and-restore-sop.md`
- 月度恢复演练模板：`docs/operations/monthly-restore-drill-record-template.md`
- 生产风险台账：`docs/operations/production-risk-register.md`
- 本机备份健康检查：`/usr/local/sbin/check-local-backup-health`
- 隔离恢复工具：`/usr/local/sbin/restore-encrypted-backup`
- Evidence 重放工具：`/usr/local/sbin/record-backup-evidence`
- 生产只读检查脚本：`/home/salaryops/task85-post-go-check.sh`
- 任务85 evidence 根目录：`/opt/salary-settlement-admin/evidence/task85-post-go`
- 任务86最终 evidence：`/opt/salary-settlement-admin/evidence/task86-20260725T163700Z`
- 任务86脱敏状态日志：`/home/salaryops/task86-status.log`
- 标准生产 Release Gate：`/home/salaryops/production-release-gate.sh`
- 当前 Gate Evidence：`/opt/salary-settlement-admin/evidence/release-gate-current`
- 最新完整脱敏 Gate JSON：`/home/salaryops/release-gate-latest.json`
- 真实权限 smoke：`/home/salaryops/production-permissions-smoke.sh`
- 任务91权限 Evidence：`/opt/salary-settlement-admin/evidence/task91-permissions-20260728T140745Z`
- 任务91独立后检：`/home/salaryops/task91-postcheck.env`

远端脚本只读取服务、容器、日志、数据库脱敏计数、release gate、env/migration evidence、备份 timer/元数据和资源状态，并写入脱敏 evidence。脚本不含凭据，不部署、不重启、不切流、不执行 migration deploy、不修改业务数据/账号/权限/告警/RC tag，也不启用 systemd timer。

## 值守规则

1. T+1/T+6/T+12 已取消且不补跑；T+24 执行前确认参数仅为 `t24h no-audit`。
2. 如需 sudo，只在可见 SSH 窗口输入；不得把密码发到聊天或写入命令参数。
3. 只读取 `/home/salaryops/task85-latest-summary.env` 和脱敏 evidence 标记；不得读取或复制生产 `.env` 原文。
4. 不复制原始日志、审计 CSV、token、session、cookie、bearer、password hash 或完整个人信息。
5. 发现异常时先保存 evidence、标记 `Post-Go Incident Risk` 并通知责任人；没有另行授权不得自动回滚。
6. release gate warning/fail 必须记录 code 并标记 `Full Go Regression`，不得把 warning 写成 Pass。

## 后续负责人和维护事项

| 事项 | 建议负责人 | 频率/期限 |
| --- | --- | --- |
| T+24 最终复核与 warning 收口 | Operations / release owner | **已完成**；T+24 evidence=`/opt/salary-settlement-admin/evidence/task85-post-go/t24h-20260725T133417Z`；stable evidence=`/opt/salary-settlement-admin/evidence/task86-20260725T163700Z` |
| 无异机备份风险复核 | Operations + data owner | 进入正式长期运营前单独评估；当前不实施、不采购、不配置 |
| 物理备份与应用 backup record 同步 | Application owner + Operations | **Resolved / Closed by task90**；每日真实密文完成后事务同步，按 basename 幂等 |
| 正式低权测试账号策略 | Security / application owner | 下一维护窗口 |
| 长期监控告警 SOP | Operations | 下一维护窗口 |
| 隔离 restore drill | Operations + data owner | 每月；可信 evidence 至少保持在90天内 |
| release gate evidence 清理/归档 | Release owner | 按月或每次发布后 |
| 生产审计导出周期性抽检 | Compliance / operations | 按月 |
| 依赖升级与安全补丁 | Application + operations | 固定月度节奏，紧急漏洞例外 |
| 业务数据导入/初始化流程 | Product + data owner | 实际需要前设计并审批 |

## 交接结论

T+24 的1440分钟窗口已完成；任务86随后以真实 production 401/403、最小 audit export 和受控账号收尾刷新过期 evidence。最终 production release gate 为 `37 pass / 0 warning / 0 fail`、exit=0；5分钟样本 0–5 全部通过，窗口内 Nginx/API/Web/PostgreSQL error 与 Nginx 5xx 均为 0，critical alerts=0；临时低权账号最终 disabled 且无活动 session。

当前最终状态为 **Full Go stable with accepted backup risk**，不建议回滚。无异机备份风险仍存在且已接受，不是当前上线阻断项；进入正式长期运营前再单独复核，任务88没有实施或推动异机备份。

任务88于 `2026-07-27T10:58:25Z` 复核：timer enabled/active；最近 service success/exit 0；最新本机备份为 `postgres-full-20260727T021616Z.sql.gz`、17,742 bytes，生成时 sidecar checksum match，gzip 完整性通过，目录/文件权限满足最小权限，磁盘使用率 4%，实际 retention 为30天。应用数据库中的 backup record 没有随每日物理备份更新，形成 monitoring-record synchronization warning；任务88未写生产数据库。

任务89于 `2026-07-27T11:40:38Z` 使用一次可见 SSH sudo 会话完成只读定位。最新物理备份事实与任务88一致；应用库只有1条任务81加密 full record，完成于 `2026-07-23T15:19:11Z`，只读检查时 age=92h，backup health 因超龄为 critical。每日脚本实际生成未加密 `.sql.gz`；若如实写入 `encrypted=false`，现有 health 会改为 `backup.not_encrypted` critical，无法满足任务89硬性目标。任务89因此在生产写入前停止：未安装 recorder，未修改 backup script/unit/retention，未执行 daemon-reload，未重启服务，未运行 migration，未写业务数据或 backup record，未运行完整 release gate，未发生回滚。交互会话和临时副本已清理。`RISK-DP-002` 保持 Open；`RISK-DP-001` 保持 Accepted。

任务86 wrapper 的唯一已知技术债是敏感扫描零匹配时 `grep` 返回 1 与 `set -e/pipefail` 冲突，导致非生产性的最终退出码错误；生产 gate、观察和清理结果不受影响。

## 任务90交接补充（2026-07-27）

实现提交为 `ed856f5eb2450c1160d63cf5532452f9f55d99fa`；冻结生产 RC 仍为
`rc-20260712-2` / `9f8f8f576dde54355983b96525335e94c55c8b32`。生产执行窗口
`2026-07-27T13:10:29Z–13:10:39Z`，没有 API/Web 部署或重启，没有 Nginx reload/
restart，没有 PostgreSQL restart，没有 migration/schema 或业务数据修改，systemd unit
未修改且未执行 daemon-reload。

| 项目 | 交接事实 |
| --- | --- |
| 最新备份 | `postgres-full-20260727T131031Z.sql.gz.enc`；18,087 bytes；SHA-256=`8b5020ad2d7f95f238e4f6010f47d6605e58d829928019dbfaeb46338048b146` |
| 加密/key | `aes-256-gcm-v1`；gzip 后加密；checksum 对 ciphertext；key=`/etc/salary-settlement-admin/backup-file-encryption.key`、`root:root 0600` |
| Evidence | BackupRecord ID=`4c99b322-073e-47c3-8537-0dd055ca5b05`；同键重放=`no_change`；审计恰好1条 |
| 恢复 | Drill=`task90-restore-20260727T131032Z`；record ID=`71f06ac2-bcea-44af-a182-339a38df0556`；PostgreSQL 16、network none、无端口、未接触生产库；2 DB / 2 role / 2 schema / 33 table / 17 migration；cleanup complete |
| Release gate | exit=0；`34 pass / 3 warning / 0 fail`；required fail=none；backup 72h/health 均 Pass；warning=`E2E_PERMISSIONS_RECENT_RUN,ENV_CHECK_AVAILABLE,MIGRATIONS_UP_TO_DATE` |
| 独立后检 | installed hashes、密文、Evidence/audit、systemd、容器、端点均 Pass；API/Web restart=`0/0`；active critical alerts=0；backup health Pass |
| Rollback 历史 | 接入过程中发生自动回滚：镜像预检、安装布局、systemd 写路径和历史 service 状态门禁依次暴露并修复；`13:00` 尝试完成密文/Evidence 后因默认 bootstrap role 冲突在隔离恢复阶段回滚；最终 `13:10` 执行未回滚 |

值守注意：key 丢失会使现有密文不可恢复，禁止擅自删除、覆盖或轮换。Evidence 写入失败时
保留密文，修复后对同一绝对路径运行 recorder；不得新造或伪造记录。RISK-DP-002 已关闭；
RISK-DP-001 仍为 Accepted / unresolved / non-blocking，RISK-DP-003 为 Open /
Mitigated / non-blocking。

## 任务91交接补充（2026-07-28）

任务91修复了任务90 Gate 入口漏挂载 Evidence 的问题，并把 env/migration Evidence
刷新固化进唯一标准入口。修复前标准 Gate generatedAt=`2026-07-28T13:42:25.916Z`，
为 `34 pass / 3 warning / 0 fail`。三项 warning 的共同事实是标准容器没有挂载
Evidence；同时最近任务86 Evidence 完成于 `2026-07-25`，在任务91执行时也已真实超过
24 小时，不能继续复用。

实现提交为 `95dcf88` 和 `d7d6e46`。生产只安装 Gate/Evidence 辅助脚本，没有部署
API/Web、重启服务、切流、执行 migration、修改 schema 或业务数据。env Evidence
第一次采集因 API 镜像非 root 用户无法写 root-only 临时目录而安全保留 warning；
补丁改为仅让一次性脱敏采集容器以 root 写入受限 `/run` 目录，随后 env 23/23 Pass。

最终真实权限 smoke 在 `2026-07-28T14:07:45Z–14:07:59Z` 完成：未认证 401、
super_admin 37 项权限链、低权登录和 `/me`、release gate run 403、管理员接口 403、
logout-all 均 Pass；既有低权账号最终 disabled，active admin/super_admin/low-priv
恢复 `1/1/0`，active session=`0`。

最终标准 Gate generatedAt=`2026-07-28T14:09:08.370Z`：
`37 pass / 0 warning / 0 fail`，所有 required/recommended fail/warning code 为 none；
env=`23/23`，migration expected/applied=`17/17`、pending=`0`、drift=`false`，
E2E=`7/7`。独立后检结束于 `2026-07-28T14:13:42Z`：Nginx/Docker/PostgreSQL active，
API/Web running/healthy/restart=`0/0`，公网三入口 HTTP 200/TLS verify 0，
backup timer enabled/active、service Result=success/exit=0、backup health Pass，
最新 full backup encrypted 且 age=`11h`，restore drill age=`1d`，critical alerts=`0`，
敏感字段/字面量匹配=`0/0`，`/run` 临时残留=`0`。

## 任务94交接补充（2026-07-30）

本机恢复副本已受控接入：

- active key 仍为 `/etc/salary-settlement-admin/backup-file-encryption.key`；每日备份和
  restore 工具未增加自动 recovery fallback。
- recovery copy 位于
  `/var/lib/salary-settlement-admin-key-recovery/backup-file-encryption.key`；
  目录 `root:root 0700`，key/metadata `root:root 0600`，非 symlink/hardlink。
- 状态检查：`sudo /usr/local/sbin/backup-key-recovery check
  --latest-backup-dir /var/backups/salary-settlement-admin`。
- 非破坏性演练：`sudo /usr/local/sbin/backup-key-recovery drill`。演练不得删除、移动、
  覆盖或轮换 active key；真实事故恢复按 backup-and-restore SOP 第9节执行。
- watchdog 每日持续检查 recovery copy 完整性、与 active key 一致性及最新真实密文
  认证解密；六类 key critical 使用稳定 fingerprint，健康恢复后自动 resolve。

最终生产窗口 `2026-07-30T14:09:53Z–14:10:04Z`，演练
`task94-key-recovery-20260730T140958Z` 对
`postgres-full-20260730T022816Z.sql.gz.enc` 完成 authentication/gzip/cleanup；
active key 未修改。最终 Gate 为 `36 pass / 1 warning / 0 fail`、exit=0，唯一 warning
为 `E2E_PERMISSIONS_RECENT_RUN`。API/Web restart `0/0`，active critical `0→0`。

root-only 回滚副本保留于 `/root/task94-rollback-20260730T140953Z`。正常值守不得删除
recovery copy 或回滚副本，不得将 key 或 recovery copy 下载到操作终端。RISK-DP-003
的 active key 单文件误删/损坏子风险已 Resolved；同盘同时损坏仍为 Accepted /
non-blocking，异机 key 托管仍未实施。
