# 生产运维交接

## 当前生产状态

- 运行版本：`rc-20260712-2` / `9f8f8f576dde54355983b96525335e94c55c8b32`
- 状态：`Full Go stable with accepted backup risk`
- 入口：Admin、API live、API ready 均通过 HTTPS；API/Web 容器健康
- PostgreSQL：系统服务 active，不公网监听
- 本机备份：`salary-postgres-backup.timer` active/enabled
- 已知风险：无异机备份，状态 **Accepted**、未解决、当前不阻断上线

任务85不是重新发布。任务82已完成部署/切流，任务84已完成真实低权 403 smoke 与 Full Go 转正；任务85完成 T+24 监控。任务86刷新过期的真实 production E2E/审计 evidence，并以 `37/0/0` 和 5 分钟无异常观察完成 stable 收口；同样没有重新部署、重启、切流或迁移。

## 交接入口

- 上线审批记录：`docs/release/production-approval-record.md`
- 24 小时监控报告：`docs/release/post-go-monitoring-report.md`
- 发布运行手册：`docs/release/production-runbook.md`
- 本机备份与隔离恢复 SOP：`docs/operations/backup-and-restore-sop.md`
- 月度恢复演练模板：`docs/operations/monthly-restore-drill-record-template.md`
- 生产风险台账：`docs/operations/production-risk-register.md`
- 本机备份只读检查脚本：`deploy/scripts/check-local-backup-health.sh`
- 生产只读检查脚本：`/home/salaryops/task85-post-go-check.sh`
- 任务85 evidence 根目录：`/opt/salary-settlement-admin/evidence/task85-post-go`
- 任务86最终 evidence：`/opt/salary-settlement-admin/evidence/task86-20260725T163700Z`
- 任务86脱敏状态日志：`/home/salaryops/task86-status.log`

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
| 物理备份与应用 backup record 同步 | Application owner + Operations | Open warning；另行授权修复，不影响已独立验证的物理备份事实 |
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

任务86 wrapper 的唯一已知技术债是敏感扫描零匹配时 `grep` 返回 1 与 `set -e/pipefail` 冲突，导致非生产性的最终退出码错误；生产 gate、观察和清理结果不受影响。
