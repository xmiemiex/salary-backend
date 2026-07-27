# 任务85–86：上线后 24 小时生产监控与 Stable 收口报告

## 状态

- RC：`rc-20260712-2`
- commit：`9f8f8f576dde54355983b96525335e94c55c8b32`
- 当前状态：`Full Go stable with accepted backup risk`
- 最终 release gate：`37 pass / 0 warning / 0 fail`，exit=0
- 已接受但未解决的风险：无异机备份（off-host backup not configured）
- 历史阶段：任务84转正为 `Full Go with accepted backup risk`；任务85 T+24 曾因 evidence 超龄进入 `Full Go Regression`，任务86已刷新真实 production evidence 并完成 stable 收口
- 监控起点：`2026-07-24T12:19:12Z`（Asia/Shanghai `2026-07-24 20:19:12`）
- 硬边界：不部署、不重启、不切流、不执行 migration deploy、不修改业务数据/账号/权限/告警/RC tag

本报告只保存脱敏摘要、计数、状态、时间戳、校验和和 evidence 路径。不得写入生产 `.env` 原文、数据库 URL、密码、token、session、cookie、bearer、private key、CSV 原文、password hash 或完整个人信息。

## 即时检查

| 检查 | 结果 |
| --- | --- |
| 自动连接生产 | Pass；Tailscale SSH，远端身份 `salaryops` |
| Nginx/Docker/PostgreSQL | active；failed units=0 |
| API/Web | running、healthy、restart=0 |
| Nginx target | `salary-production-rc-20260712-2` |
| Admin/API live/API ready | HTTP 200；TLS verify=0 |
| PostgreSQL 公网监听 | 0 |
| 磁盘/内存 | 4% / 11% |
| 最近 15 分钟日志 | Nginx 5xx/error、API/Web/PostgreSQL error、OOM/disk-full 均为 0 |
| 最近 1 小时日志 | Nginx 5xx/error、API/Web/PostgreSQL error、OOM/disk-full 均为 0；401=1、403=0，无异常峰值 |
| env check | 23/23 Pass |
| migration evidence | expected/applied=17/17、pending=0、drift=false |
| release gate | `37 pass / 0 warning / 0 fail`，exit=0 |
| active admin/super_admin/low-priv | `1 / 1 / 0` |
| 任务84临时账号 | matches=1、disabled=1、active=0、active sessions=0 |
| permissions | 37 |
| critical alerts | 0 |
| system/backup health | `warning`（non-critical）/ `ok` |
| backup timer | active/enabled |
| timer last/next | `2026-07-24T02:23:46Z` / `2026-07-25T02:24:36Z` |
| latest full backup | succeeded、full、encrypted、21 小时内 |
| latest restore drill | succeeded、3 天内 |
| audit export smoke | Pass；3 条、1036 bytes、sensitive leak=false；临时 CSV/token 删除并 logout |
| sensitive evidence scan | 0 matches |

即时主 evidence：`/opt/salary-settlement-admin/evidence/task85-post-go/immediate-20260724T121912Z`。

数据库补充 evidence：`/home/salaryops/task85-db-summary-rerun.log`，SHA-256=`800c43e02ec41a3df628160e2a467020d86bb8e0942472f70e25ac57ee541759`。

初版主 summary 中唯一 failure code `DATABASE_SUMMARY` 来自 helper 模块挂载路径错误；失败发生在 Prisma 客户端加载阶段，未建立数据库查询。修正到 `/app` 后只读补充复核通过，因此不构成生产异常。后续远端脚本已修正。

## 复核计划（已调整）

`2026-07-25` 经用户确认，不再执行 T+1/T+6/T+12 定点复核，也不补跑；只保留 T+24 最终复核。生产已完成 Full Go，短期即时检查已通过，本阶段接受通过减少人工 sudo 交互和 token 消耗来换取更低的中间检查频率。

| 检查点 | 计划时间（Asia/Shanghai） | 结果 | Evidence |
| --- | --- | --- | --- |
| 即时 | `2026-07-24 20:19` | **Pass**；无生产异常 | 见上 |
| T+1h | `2026-07-24 21:20` | **Cancelled / Not executed** | 策略调整，不补跑 |
| T+6h | `2026-07-25 02:20` | **Cancelled / Not executed** | 策略调整，不补跑 |
| T+12h | `2026-07-25 08:20` | **Cancelled / Not executed** | 策略调整，不补跑 |
| T+24h | `2026-07-25 20:20` | **Completed / Warning** | Final evidence：`/opt/salary-settlement-admin/evidence/task85-post-go/t24h-20260725T133417Z` |

T+1/T+6/T+12 没有已激活自动任务，现明确取消。仅生成 T+24 的时区锚定唤醒卡片，需在应用内确认后才生效。远端只读执行入口为：

```text
/home/salaryops/task85-post-go-check.sh t24h no-audit
```

脚本需通过 sudo 运行；用户只在可见 SSH 窗口输入 sudo 密码。脚本不含凭据，不修改生产服务配置，不启用 systemd timer。

## T+24 Attempt 1（不满足最终复核口径）

执行时间为 `2026-07-25T13:31:18Z–13:31:23Z`（Asia/Shanghai `21:31:18–21:31:23`）。实际命令没有传入 `t24h no-audit`，脚本采用 `TASK85_LABEL=immediate`、`TASK85_HORIZON_MINUTES=60`，所以未覆盖要求的最近24小时日志。本次只能作为 T+24 尝试记录，不能据此宣布 stable。

| 检查 | 结果 |
| --- | --- |
| 禁止操作边界 | Pass；未部署、未重启、未切 Nginx、未执行 migration、未写业务数据 |
| Admin/API live/API ready | HTTP 200；TLS verify=0 |
| Nginx/Docker/PostgreSQL | active；failed units=0 |
| API/Web | running、healthy、restart=0 |
| Nginx target / PostgreSQL public listeners | 授权 RC / 0 |
| 15分钟及60分钟日志 | Nginx 5xx/error、API/Web/PostgreSQL error、OOM/disk-full 均为 0 |
| 最近24小时日志 | **Incomplete / Not collected** |
| active critical alerts | 0 |
| release gate | **Warning**；`35 pass / 2 warning / 0 fail`；exit=0 |
| required warning | `E2E_PERMISSIONS_RECENT_RUN` |
| recommended warning | `AUDIT_LOG_RECENT_ACTIVITY` |
| backup timer | active/enabled；当日已自然触发 |
| latest full backup | succeeded/full/encrypted；age=46h；72小时门禁 Pass |
| restore drill | succeeded；age=5d；90天门禁 Pass |
| active admin/super_admin/low-priv | `1 / 1 / 0` |
| 任务84临时账号 | disabled=1、active=0、active sessions=0 |
| audit export smoke | **Pending**；本次 `not_requested` |
| sensitive scan | Pass；0 matches |
| 脚本总判定 | **Fail / release-blocking**；`RELEASE_GATE_REGRESSION` |

结论：该次尝试未满足24小时窗口，但正确参数复核已于三分钟后完成，最终结果如下。

## T+24 最终复核

执行时间为 `2026-07-25T13:34:17Z–13:34:22Z`（Asia/Shanghai `21:34:17–21:34:22`）。脚本标签为 `t24h`，观察窗口为 1440 分钟。

| 检查 | 结果 |
| --- | --- |
| 禁止操作边界 | Pass；未部署、未重启、未切 Nginx、未执行 migration、未写业务数据、未创建或修改账号 |
| Admin/API live/API ready | HTTP 200；TLS verify=0 |
| Nginx/Docker/PostgreSQL | active；failed units=0 |
| API/Web | running、healthy、restart=0 |
| Nginx target / PostgreSQL public listeners | 授权 RC / 0 |
| 最近24小时错误与 5xx | Pass；Nginx 5xx/error、API/Web/PostgreSQL error、OOM/disk-full 均为 0 |
| 401/403 anomaly | false |
| active critical alerts | 0 |
| release gate | **Warning**；`35 pass / 2 warning / 0 fail`；exit=0；required fail=none |
| required warning | `E2E_PERMISSIONS_RECENT_RUN` |
| recommended warning | `AUDIT_LOG_RECENT_ACTIVITY` |
| backup timer | active/enabled；last=`2026-07-25T02:24:43Z`；next=`2026-07-26T02:23:11Z` |
| latest full backup | succeeded/full/encrypted；age=46h；72小时门禁 Pass |
| restore drill | succeeded；age=5d；90天门禁 Pass |
| active admin/super_admin/low-priv | `1 / 1 / 0` |
| 任务84临时账号 | disabled=1、active=0、active sessions=0 |
| permissions | 37 |
| audit export smoke | **Pending（允许）**；本次 `not_requested` |
| sensitive scan | Pass；0 matches |
| 脚本总判定 | **Fail / release-blocking**；`RELEASE_GATE_REGRESSION` |

最终 evidence：`/opt/salary-settlement-admin/evidence/task85-post-go/t24h-20260725T133417Z`。

## 任务85历史决定与建议（已由任务86收口取代）

任务85结束时，T+24 覆盖已完整完成，但 release gate 出现 warning，因此当时不能将状态改为 `Full Go stable with accepted backup risk`。该历史阶段状态为 `Full Go Regression（T+24 release gate warning）`；任务86的最终收口结果见下文。

**不建议立即回滚**：公网、TLS、服务、容器、24小时错误/5xx、critical alerts、备份、恢复证据及敏感信息检查均正常，release gate 没有 fail 且 exit=0。

**建议返修**：另开明确授权任务执行新的真实低权 403 smoke，以处理 required warning `E2E_PERMISSIONS_RECENT_RUN`；如需处理 `AUDIT_LOG_RECENT_ACTIVITY`，可在管理员凭据仅于可见 SSH 窗口交互输入的前提下执行最小 audit export smoke。不得修改 evidence 时间戳、用数据库计数替代真实 403 smoke、重新启用任务84账号或在任务85内创建账号。

## T+24 最终复核范围

- Admin、API live、API ready 均为 HTTP 200，TLS 正常。
- Nginx、Docker、PostgreSQL 均为 active，failed units=0。
- API/Web 均为 running、healthy、restart=0。
- 统计最近 24 小时 Nginx/API/Web/PostgreSQL error 与 HTTP 5xx。
- active critical alerts=0，并执行 production release gate。
- backup timer active/enabled，核验 latest full backup 和 restore drill evidence 仍有效。
- 任务84临时低权账号仍 disabled、无活动 session；记录 active admin/super_admin/low-priv 计数。
- 执行 audit export smoke；如需要管理员凭据，可标记 Pending，或让用户仅在可见 SSH 窗口交互输入。
- 执行敏感信息检查；不得记录生产 `.env`、数据库 URL、密码、token、session、cookie、bearer、private key、CSV 原文、password hash 或完整个人信息。
- 更新本报告和 `docs/release/production-approval-record.md`。

## 判定规则

- 任何公网非 200/TLS 失败、服务 inactive、容器非 healthy、restart 增加、PostgreSQL 公网监听、critical alert、release gate fail、显著 5xx/错误/OOM/disk-full 或敏感泄露：标记 `Post-Go Incident Risk`，给出是否需要返修或人工回滚的建议，但不自动回滚。
- release gate 新增 warning/fail：记录 codes 并标记 `Full Go Regression`，不得掩盖。
- T+24 时任务84 e2e evidence 可能刚超过 24 小时有效期；若出现 `E2E_PERMISSIONS_RECENT_RUN` warning，必须如实记录，不能通过修改 evidence 时间戳或数据库计数伪造真实 403 smoke。
- T+24 全部通过时，将状态改为 `Full Go stable with accepted backup risk`。
- T+24 出现任何 warning/fail 时，如实记录并明确是否建议返修或人工回滚；不得自动回滚。

## 未解决风险

无异机备份风险仍存在且已接受，但没有解决。当前本机 timer、加密 full backup 和隔离 restore drill 不能覆盖 Droplet 整机、同机存储或区域性故障。任务85不手动触发备份；T+24 只验证 timer 是否自然触发。

## 任务86 Warning 回归修复与 Stable 收口

最终有效执行时间为 `2026-07-25T16:37:00Z–16:42:21Z`（Asia/Shanghai `2026-07-26 00:37:00–00:42:21`）。本次只刷新真实 production 权限 E2E 与审计活动 evidence，并重跑 production release gate；未部署、未重启、未切流、未迁移、未修改 schema/migration、未导入业务数据、未修改 super_admin 权限，也未回滚。

| 检查 | 结果 |
| --- | --- |
| 自动生产连接 | Pass；Tailscale `100.103.6.23`，远端身份 `salaryops` |
| 用户交互 | 仅在可见 SSH 窗口输入 sudo 与现有 super_admin 凭据；凭据未进入聊天或 evidence |
| HTTP/TLS/服务/容器 | Admin/API live/API ready HTTP 200、TLS verify=0；Nginx/Docker/PostgreSQL active；failed units=0；API/Web healthy、restart=0 |
| warning 根因 | T+24 时真实 E2E 权限 evidence 与审计近期活动均已过有效期；未伪造时间戳或 CI evidence |
| E2E permissions | Pass；未登录 401、super_admin 37 项权限链、真实低权登录和 `/me`、release gate run 403、管理员接口 403、logout-all 全部通过 |
| 临时低权账号 | 复用任务84已禁用账号；只读确认唯一最小角色；最终 disabled，active low-priv=0，active sessions=0 |
| audit export smoke | Pass；6 条、2018 bytes、sensitive leak=false；24小时 audit activity count=11；CSV 已删除 |
| 最终 release gate | **`37 pass / 0 warning / 0 fail`，exit=0**；generatedAt=`2026-07-25T16:37:17.975Z` |
| 5分钟观察 | 样本 0–5 全部 Pass；API/Web/PostgreSQL/Nginx error=0；Nginx 5xx=0；critical alerts=0 |
| 账号/备份/恢复收尾 | active admin/super_admin/low-priv=`1/1/0`；backup 49小时内；restore drill 5天内；最终数据库汇总 Pass |
| 敏感检查 | 零匹配；无 token/session/CSV 临时目录残留，未发现敏感信息 |

最终 evidence：`/opt/salary-settlement-admin/evidence/task86-20260725T163700Z`。

自动化 wrapper 在全部检查通过后因 `grep` 的“零匹配返回 1”与 `set -e/pipefail` 冲突而写出 `CORE_COMPLETE=fail`。这是收尾脚本退出码缺陷，不是生产异常；生产权威结果、账号清理和观察均已在该缺陷触发前通过。后续技术债是将零匹配显式归一为成功。

最终状态：**Full Go stable with accepted backup risk**。不建议回滚。未解决风险仍为无异机备份；该风险已接受且不是当前上线阻断项。进入正式长期运营前须单独复核，是否实施异机备份须另行决策和授权。
