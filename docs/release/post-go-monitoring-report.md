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

## 任务90备份接入后检（2026-07-27）

任务90最终生产执行于 `2026-07-27T13:10:39Z` 成功结束，并在
`2026-07-27T13:13:23Z` 完成独立只读复核。它没有重新部署、重启、切流或迁移。

| 检查 | 结果 |
| --- | --- |
| 新加密备份 | Pass；`postgres-full-20260727T131031Z.sql.gz.enc`；ciphertext checksum、GCM 认证解密、gzip 均通过；无同时间戳明文 |
| Evidence | Pass；BackupRecord/RestoreDrillRecord 字段匹配；对应成功审计各1条；backup recorder 重放=`no_change` |
| 隔离恢复 | Pass；PostgreSQL 16、network none、无端口、未接触生产 DB；2 DB / 2 role / 2 schema / 33 table / 17 migration；资源清理完成 |
| systemd | Pass；timer enabled/active；service Result=success、exit=0；failed units=0 |
| 服务/容器/入口 | Pass；Nginx/Docker/PostgreSQL active；API/Web healthy、restart=`0/0`；本机与公网 health 入口通过 |
| 告警 | Pass；active critical alerts=0 |
| Backup health | Pass；warning/failure codes=none；最新密文 age=172s |
| Release gate | exit=0；`34 pass / 3 warning / 0 fail`；backup 72h/health Pass；warnings=`E2E_PERMISSIONS_RECENT_RUN,ENV_CHECK_AVAILABLE,MIGRATIONS_UP_TO_DATE` |
| 临时资源 | Pass；无 task90 restore container/volume；诊断和独立复核临时脚本/日志已删除 |

本次 release gate 不是全绿，三个 warning 必须继续按原 gate 语义记录；但没有 fail，且两个
备份门禁均 Pass。RISK-DP-002 已关闭；RISK-DP-001 仍为 Accepted / unresolved /
non-blocking。此前失败尝试均触发旧备份入口自动回滚；最终执行没有回滚。

## 任务92：每日加密备份 T+48 无人值守验收（2026-07-30）

最终只读核验窗口为 `2026-07-30T10:39:11Z–10:39:15Z`。起始 Git 基线为
`main`，`HEAD=origin/main=15839a495aff64b4e778b5c62ba57540fba3a0d6`；
`rc-20260712-2^{commit}=9f8f8f576dde54355983b96525335e94c55c8b32`。既有
`release-staging-task80-20260721T1225/` 只确认目录名存在，未读取、修改或提交。

### Timer、service 与计划运行

| 检查 | 脱敏结果 |
| --- | --- |
| timer | `salary-postgres-backup.timer` enabled/active；`Triggers=salary-postgres-backup.service` |
| 调度 | `OnCalendar=02:15 UTC`、`RandomizedDelaySec=15m`、`Persistent=true` |
| 最近/下次触发 | `2026-07-30T02:28:16Z` / `2026-07-31T02:17:20Z` |
| service | oneshot 当前 inactive；最近 `Result=success`、`ExecMainStatus=0`，完成于 `2026-07-30T02:28:17Z` |
| failed units | `0` |
| 任务90后计划运行 | 三次：`2026-07-28T02:23:43Z`、`2026-07-29T02:28:16Z–02:28:17Z`、`2026-07-30T02:28:16Z–02:28:17Z`；均位于 timer 窗口，journal 脱敏状态均为 backup/encryption/checksum/decrypt/gzip/retention success、Evidence created |

最近两次计划运行与任务90的 `2026-07-27T13:10Z` 手动验证明确区分，且均由
timer/service 关联、调度窗口和独立 invocation 输出共同证明，不使用手动备份冒充。
未提交原始 journal。

### 最近两份计划密文与 BackupRecord

| 项目 | `2026-07-29` 计划备份 | `2026-07-30` 计划备份 |
| --- | --- | --- |
| basename | `postgres-full-20260729T022816Z.sql.gz.enc` | `postgres-full-20260730T022816Z.sql.gz.enc` |
| 运行窗口 | `02:28:16Z–02:28:17Z`；success | `02:28:16Z–02:28:17Z`；success |
| 文件 | regular file、非 symlink、19,302 bytes | regular file、非 symlink、19,472 bytes |
| owner/group/mode | `root:postgres 0640` | `root:postgres 0640` |
| sidecar / ciphertext SHA-256 | sidecar 格式与权限正确；match | sidecar 格式与权限正确；match |
| 认证解密 / gzip | AES-256-GCM authentication Pass；流式 `gzip -t` Pass | AES-256-GCM authentication Pass；流式 `gzip -t` Pass |
| 同时间戳明文 | `.sql` / `.sql.gz` / 临时明文均为 0 | `.sql` / `.sql.gz` / 临时明文均为 0 |
| BackupRecord ID | `aad9c4ae-64c3-4644-a162-bc8073cffdda` | `dd8bdc79-7b87-4f91-bbfd-5d64c8e84c44` |
| Record 一致性 | count=1；succeeded/full/encrypted；backupKey、size、checksum、started/completed、storage/encryption/scope/safe metadata 全部匹配 | count=1；succeeded/full/encrypted；backupKey、size、checksum、started/completed、storage/encryption/scope/safe metadata 全部匹配 |

两条 `backupKey` 的数据库计数均为 1，无重复、缺失、冲突或失败冒充 succeeded。只执行了
Prisma 只读查询，没有运行 recorder 或补写 Evidence，没有查询或输出业务行。

### 明文、容量、key 与保留策略

| 检查 | 脱敏结果 |
| --- | --- |
| 当前密文 / 历史明文数 | `8 / 10`；历史明文按既有 retention 自然保留 |
| 最新历史明文 | `postgres-full-20260727T021616Z.sql.gz`，mtime=`2026-07-27T02:16:17Z`，早于任务90最终接入 |
| 任务90后新明文 / 临时明文 | `0 / 0` |
| 备份目录 | 227,119 bytes；目录/文件无 world-readable、world-writable 或 group-writable |
| 文件系统 | 248,505,155,584 bytes；可用 239,715,328,000 bytes；使用率 4%，低于 80% warning / 90% critical |
| 30 天估算 | 最近两份平均 19,387 bytes；30 天数据文件约 581,610 bytes，不含少量 sidecar/文件系统开销 |
| retention | 30 天；过期清理由 root-owned 每日备份脚本的既定 `delete_expired_backups` 路径管理；未手工删除旧备份 |
| encryption key | 文件存在、非 symlink、`root:root 0600`；metadata 确认为 `aes-256-gcm-v1` 用途；未读取或输出 key 内容 |
| 本机 backup health | `pass`；warning/failure codes=`none` |

### 标准 Release Gate 与生产健康

标准入口 `sudo /home/salaryops/production-release-gate.sh` 在
`2026-07-30T10:39:15.599Z` 完成，exit=`0`：

| 检查 | 脱敏结果 |
| --- | --- |
| Gate 总计 | `36 pass / 1 warning / 0 fail` |
| required fail / warning | `none` / `E2E_PERMISSIONS_RECENT_RUN` |
| recommended fail / warning | `none` / `none` |
| warning safeDetails | `persisted=false`、`artifact.available=false`、`checksTotal=null`、`cleanup=null` |
| backup 72h | `RECENT_FULL_BACKUP_WITHIN_72H=pass`；age=`8h` |
| backup health | `BACKUP_HEALTH_NOT_CRITICAL=pass`；status=`ok` |
| system health / critical alerts | gate=`pass`、status=`warning`（non-critical）；active critical alerts=`0` |
| env / migration | Evidence gates 均 Pass |
| E2E warning 判定 | 任务91最后一次真实 production 权限 E2E 已超过固定 24 小时有效期；本任务未运行 permissions smoke、未刷新或伪造 Evidence；该唯一 warning 为 expected / non-blocking |

生产后检：Nginx、Docker、PostgreSQL 均 active，failed units=`0`；API/Web 均
running/healthy，restart count 在核验前后保持 `0/0`；API live、API ready、Web health
均为 HTTP 200；PostgreSQL 公网 `0.0.0.0/[::]/*:5432` 监听数为 0；active critical
alerts=`0`。task92 临时 container、volume、`/run`/`/tmp` 脚本或明文残留均为 0。

初次采集因三个检测口径错误（key metadata 扩展名、历史 retention 明文与临时明文混计、
Docker bridge 监听与公网监听混计）安全停止在 Gate 之前，没有改变生产。修正检测口径后
重新完整只读执行，上述结果为唯一权威结论；修正不涉及生产脚本、unit、timer、Gate 规则
或 Evidence。

本任务没有部署 API/Web，没有重启或 reload API、Web、Nginx、Docker、PostgreSQL，
没有 daemon-reload、migration、schema/业务数据/账号/权限变更，没有手动触发 full
backup、删除备份、修改 retention、运行 recorder、切流或移动 RC tag。无异机备份风险
`RISK-DP-001` 与 key 丢失风险 `RISK-DP-003` 均保持原状态。

脱敏文档仅记录时间、状态、exit code、安全 code、basename、大小、权限和 record ID；
不包含 key、`.env`、token、数据库 URL、dump、CSV、原始 journal 或原始 Evidence。
任务92结论：`TASK92_OBSERVATION_COMPLETE`。

## 任务93生产接入与恢复闭环（2026-07-30）

### 自动 watchdog 状态

| 检查 | 脱敏结果 |
| --- | --- |
| 接入窗口 | `2026-07-30T12:29:41Z–12:29:45Z` |
| timer | enabled/active；`04:00 UTC` + 最多 15 分钟随机延迟；Persistent=true；下一次 `2026-07-31T04:03:08Z` |
| service | oneshot；Result=success；ExecMainStatus=0 |
| 当前告警 | watchdog active=0；active critical baseline=`0`，接入后=`0` |
| synthetic 第一次 | generated=1；active=1；notifications created=1 |
| synthetic 第二次 | generated=0；updated=1；active=1；notifications created=0 |
| synthetic 恢复 | resolved=1；active=0；历史和审计记录保留 |
| 原备份 | timer enabled/active；service success/0；最后触发 `2026-07-30T02:28:16Z` |
| 容量 | `/dev/vda1` 使用率 4%；可用 239,706,480,640 bytes |
| 回滚 | root-only 副本已建立；生产接入未触发回滚 |

生产 synthetic 使用专用 source/fingerprint 和 `synthetic=true/task93`，没有伪装成真实
备份事故。稳定 dedup key 令重复检查只更新时间；resolve 仅作用于 Task93 自身 source。
fixture/self-test 已覆盖 timer/service、36h、文件/checksum、BackupRecord、health、
80%/90%/<5 GiB 和 watchdog failure 分支。

### 接入后标准 Release Gate

标准入口在 `2026-07-30T13:00:41.248Z` 完成，exit=0：

| 检查 | 脱敏结果 |
| --- | --- |
| Gate 总计 | `36 pass / 1 warning / 0 fail` |
| required fail / warning | `none` / `E2E_PERMISSIONS_RECENT_RUN` |
| recommended warning | `none` |
| backup 72h | Pass；age=`10h` |
| backup health | Pass；status=`ok` |
| active critical | Pass；count=`0` |
| system health | Pass；聚合 status=`warning`，由上述非故障 E2E warning 导致 |

后检 Nginx、Docker、PostgreSQL active，failed units=0；API/Web 在 Task93 接入前后均
healthy，restart count 为 `0/0`。上传 staging 已清理；最终文档提交前删除
`/home/salaryops/task93-result.env`。root-only 回滚副本按变更恢复要求保留，不包含 secret
输出。

本任务没有运行 production permissions smoke，没有刷新或伪造权限 Evidence；没有部署
或重启 API/Web/Nginx/PostgreSQL，没有 migration、schema/业务数据、key、备份格式、
retention、历史备份、RC 标签或异机备份变更。RISK-DP-001 与 RISK-DP-003 状态不变。

## 任务94生产接入后监控与恢复验证（2026-07-30）

生产接入最终窗口为 `2026-07-30T14:09:53Z–14:10:04Z`。接入前后 API/Web restart
均为 `0/0`，Nginx、Docker、PostgreSQL 保持 active，API/Web 保持 healthy，active
critical alerts 为 `0→0`。

| 检查 | 脱敏结果 |
| --- | --- |
| recovery copy | 目录 `root:root 0700`，key/metadata `root:root 0600`；普通文件、非 symlink、非 hardlink；active/recovery byte match |
| watchdog 当前状态 | active/recovery 均 valid，metadata valid，content match；用 recovery key 对最新真实密文认证解密 Pass；候选异常 0 |
| synthetic 幂等 | 同一稳定 Alert ID：reactivated=1，随后 updated=1；未创建第二条活动告警 |
| synthetic 恢复 | resolved=1；active=0；Alert/audit 历史保留 |
| active key | 演练前后未修改；未删除、移动、覆盖或轮换 |
| 最新真实密文 | `postgres-full-20260730T022816Z.sql.gz.enc`；checksum、GCM authentication、gzip 均 Pass |
| 恢复演练 | `task94-key-recovery-20260730T140958Z`；临时 key 仅位于 `/run`；authentication/gzip/cleanup Pass |
| 原备份服务 | timer enabled/active；service Result=success、ExecMainStatus=0 |
| 标准 Gate | `2026-07-30T14:10:03.847Z`；exit=0；`36 pass / 1 warning / 0 fail` |
| 唯一 warning | `E2E_PERMISSIONS_RECENT_RUN`，如实保留；未运行 permissions smoke，未刷新或伪造 Evidence |
| 临时残留 | 上传 staging 已删除；`/run`/临时演练资源无残留；root-only rollback 按恢复要求保留 |

本任务没有新增无认证 HTTP 接口，没有让日常 backup/restore 自动 fallback 到 recovery
copy；只有人工事故 SOP 可恢复 active key。未部署或重启 API/Web，未重启
Nginx/PostgreSQL，未 daemon-reload、migration、修改业务数据、账号权限、retention、
历史备份或 RC 标签。未配置异机备份或异机密钥托管。

RISK-DP-003 的 active key 单文件误删/损坏子风险已 Resolved；同盘同时损坏仍为
Accepted / non-blocking，整体仍为 Open / Mitigated / non-blocking。RISK-DP-001
继续为 Accepted / unresolved / non-blocking。
