# PostgreSQL 本机备份与隔离恢复演练 SOP

## 1. 适用范围与硬边界

本 SOP 适用于生产 Droplet 上 PostgreSQL 16 的本机每日逻辑备份、只读健康检查和月度隔离恢复演练。当前生产状态为 `Full Go stable with accepted backup risk`。

当前架构只有同一 Droplet 上的本机备份，没有 DigitalOcean Spaces、S3、对象存储、远端同步或其他异机副本。无异机备份风险状态为 **Accepted**，尚未解决，但不是当前上线阻断项。本 SOP 不授权建设异机备份；进入正式长期运营前应单独复核，是否实施须另行决策和授权。

禁止：

- 直接恢复到生产 PostgreSQL、生产数据库名或生产容器；
- 停止、重启或 reload PostgreSQL、API、Web、Nginx；
- 修改 systemd unit、timer、备份脚本、权限或 retention；
- 删除、覆盖、移动或重新生成现有生产备份；
- 把备份、数据库 dump、原始日志、原始 evidence、真实凭据或生产 `.env` 放入 Git；
- 查询、显示或导出业务明细；
- 自动修复检查发现的异常。

## 2. 已验证的生产实现

2026-07-27 只读复核得到以下事实：

| 项目 | 实际值 |
| --- | --- |
| Timer | `salary-postgres-backup.timer` |
| Service | `salary-postgres-backup.service`，`Type=oneshot` |
| 执行程序 | `/usr/local/sbin/salary-postgres-backup`，`root:root`、`0750` |
| 调度 | 每日 `02:15 UTC`，`RandomizedDelaySec=15m`，`Persistent=true` |
| 本地时区换算 | Asia/Shanghai 每日 `10:15` 起，最多随机延后 15 分钟 |
| 备份目录 | `/opt/salary-settlement-admin/backups` |
| 每日文件格式 | `postgres-full-<UTC timestamp>.sql.gz` |
| Checksum | 同名 `.sha256` sidecar；用 `sha256sum -c` 校验 |
| 目录权限 | `root:postgres`、`0750` |
| 备份文件权限 | `root:postgres`、`0640` |
| Checksum 权限 | `root:postgres`、`0640` |
| Retention | 备份脚本中实际配置为 30 天 |
| 异机备份 | 未配置；风险为 Accepted |

oneshot service 执行完成后显示 `inactive (dead)` 是正常状态。成功条件是 timer 为 enabled/active，service 最近一次 `Result=success` 且 `ExecMainStatus=0`。

### 2.1 任务88事实快照

检查时间：`2026-07-27T10:58:25Z`。

| 项目 | 结果 |
| --- | --- |
| Timer | enabled、active |
| 最近触发 | `2026-07-27 02:16:16 UTC` |
| 最近 service 完成 | `2026-07-27 02:16:17 UTC`，Result=success，exit=0 |
| 下次计划 | `2026-07-28 02:22:14 UTC` |
| 最新备份 | `postgres-full-20260727T021616Z.sql.gz` |
| 最新备份时间/age | `2026-07-27 02:16:17 UTC`；检查时约 8 小时 42 分 |
| 大小 | 17,742 bytes（文件系统显示约 20 KiB） |
| Checksum | 生成时 sidecar；只读复核 match |
| gzip 完整性 | `gzip -t` 通过 |
| 权限 | 文件及 sidecar 均为 `root:postgres`、`0640` |
| 目录 | `root:postgres`、`0750` |
| 宽权限扫描 | world-readable=0、world-writable=0、group-writable=0 |
| 当前文件数/目录占用 | 13 个备份数据文件；133,485 bytes |
| 最早/最新文件时间 | `2026-07-20T12:01:33Z` / `2026-07-27T02:16:17Z` |
| 文件系统 | 248,505,155,584 bytes；已用 8,110,804,992；可用 240,377,573,376；使用率 4% |
| 容量判断 | 当前容量足以支持既有 30 天 retention；仍须每天按阈值检查 |

应用数据库中的最近 backup record 没有随每日物理备份更新，任务88检查时 `BACKUP_WITHIN_72H=fail`；但物理 timer、journal、文件、生成时 checksum 和 gzip 完整性均证明当日备份成功。这是**监控记录同步 warning**，不能伪装为物理备份失败，也不能反过来把物理文件当作数据库记录已更新。修复数据库记录属于生产数据写入，须另行授权，本任务未执行。

## 3. 每日只读检查

推荐入口：

```bash
sudo bash /home/salaryops/task88-check-local-backup-health.sh
```

执行前由受控运维工作站把仓库中的 `deploy/scripts/check-local-backup-health.sh` 上传到上述唯一临时路径；执行后删除远端临时副本。不得安装为 systemd unit 或启用新 timer。

脚本自动从 service 的 `ReadWritePaths=` 获取备份目录，不要求操作员手工推导。它只读取 systemd、备份元数据、sidecar、gzip 和磁盘状态，不创建或删除备份、不修改权限、不重启服务。

成功输出：

- `TASK88_BACKUP_HEALTH_STATUS=pass`
- `TASK88_BACKUP_HEALTH_FAILURE_CODES=none`

warning 输出仍为 exit 0，但必须处理 `TASK88_BACKUP_HEALTH_WARNING_CODES`。fail 输出为非零，必须停止依赖该备份的发布或恢复动作。

### 3.1 每日阈值

日常发现目标不能等到 release gate 的 72 小时边界：

| 检查 | Warning | Critical / Fail |
| --- | --- | --- |
| 最新成功物理备份 age | `>=36h` | `>=48h` |
| 每日计划周期 | 超过一个计划周期未生成时立即调查 | 第二个周期仍未恢复或明确失败 |
| 磁盘使用率 | `>=80%` | `>=90%` |
| checksum | 不适用 | sidecar 缺失且无生成时可信 hash、或不匹配 |
| gzip 完整性 | 不适用 | `gzip -t` 非零 |
| 权限 | 不适用 | world-readable、world-writable、非必要 group-writable |

release gate 的独立标准仍是最近 72 小时内存在成功 full backup；不得用 72 小时取代日常 36/48 小时阈值。

## 4. Timer、service 与备份检查

以下命令只读，但读取受限目录、完整 journal 和 Docker 状态通常需要 sudo：

```bash
sudo systemctl is-enabled salary-postgres-backup.timer
sudo systemctl is-active salary-postgres-backup.timer
sudo systemctl show salary-postgres-backup.timer \
  -p LastTriggerUSec -p NextElapseUSecRealtime -p Unit -p Result
sudo systemctl show salary-postgres-backup.service \
  -p Type -p Result -p ExecMainStatus -p ActiveEnterTimestamp -p InactiveEnterTimestamp
sudo journalctl -u salary-postgres-backup.service -n 20 --no-pager
sudo bash /home/salaryops/task88-check-local-backup-health.sh
```

健康脚本按上一节的临时上传、执行、删除方式使用。不得读取生产 `.env` 原文。

失败条件：

- timer 或 service 不存在；
- timer 不是 enabled/active；
- 最近 service `Result` 不是 success 或 exit 非 0；
- 找不到可信计划运行记录；
- 最新备份缺失、为空、超过 48 小时；
- checksum 不可验证或不匹配；
- gzip 完整性失败；
- 权限过宽；
- retention 无法从可信 root-owned 执行脚本确定；
- 磁盘使用率达到 90%。

## 5. 异常处理与升级

### 5.1 备份失败

1. 停止恢复演练和依赖新备份的变更。
2. 记录 timer last/next、service Result/exit、最新文件时间和脱敏 journal 摘要。
3. 不自动重启 PostgreSQL，不手动触发备份，不修改 timer/service。
4. 通知 Operations owner 和 data owner。
5. 单次失败立即调查；连续两个计划周期失败升级为生产数据保全事件。
6. 修复和补跑须使用单独变更授权。

### 5.2 Checksum 不匹配或缺失

1. 不恢复该文件，不新建 checksum 掩盖缺失。
2. 保留原文件和 sidecar，不移动、不覆盖。
3. 如果有备份生成时留下的可信原始 SHA-256，可只读比对；临时计算值不能冒充生成时 evidence。
4. 标记该备份不可用，检查前一个有效备份，并升级给 Operations owner 和 data owner。

### 5.3 磁盘空间不足

1. `>=80%` 建立 warning 并评估增长速度；`>=90%` 标记 critical。
2. 不自动删除旧备份，不修改 retention。
3. 绝不删除最近唯一有效备份。
4. 由 Operations owner 在单独授权下决定扩容或按已批准 retention 精确清理。

### 5.4 数据库 backup record 未同步

物理备份检查与应用数据库记录是两条证据链。物理备份通过但 record 超龄时：

- 记录为 monitoring-record synchronization warning；
- 不把数据库记录写成已更新；
- 不在本 SOP 检查中写生产数据库；
- 由 application owner 与 Operations owner 另行修复记录接入。

任务89于 `2026-07-27T11:40:38Z` 只读核验后停止实施。每日脚本当前生成未加密的
`postgres-full-<UTC timestamp>.sql.gz`，而应用 `BackupHealthService` 会把最新成功
full record 的 `encrypted=false` 判为 `backup.not_encrypted` critical。当前唯一
backup record 是任务81的加密 full backup，已超出72小时。为每日文件如实补录
`encrypted=false` 虽能更新72小时 age，但不能满足 backup health 非 critical；
写成 `encrypted=true` 属于伪造，降低 health 规则或改造/新生成加密备份均不在任务89
授权边界内。因此任务89没有写入 backup record、没有安装 recorder、没有修改每日备份
脚本或 unit。后续修复必须先由 product/data/application/operations owner 明确选择：

1. 授权把每日备份改为真实文件级加密，并对新的真实加密 full backup 建立 record；或
2. 另行批准并论证 backup health 对本机未加密备份的政策变更。

不得用 `encrypted=true` 伪装现有 `.sql.gz`，也不得仅为清除门禁而降低检查。

## 6. 月度隔离恢复演练

每月执行一次，并使用 [月度恢复演练记录模板](monthly-restore-drill-record-template.md)。开始前必须确认生产服务健康、failed units=0、API/Web restart count 未增加、三个公网入口正常、active critical alerts=0。

既有可信证据：`2026-07-20T13:00:20Z` 演练从 `postgres-full-20260720T120133Z.sql.gz` 恢复到隔离 PostgreSQL 16 容器；`network=none`、无 host port、未接触或修改生产 PostgreSQL；验证 server version `160014`、两个非模板数据库和一个非系统源角色；容器退出、恢复进程清零、临时脚本删除。受限原始报告位于 `/opt/salary-settlement-admin/backups/restore-drills/restore-drill-20260720T130020Z.log`。任务88复核沿用该证据，没有执行新演练。

### 6.1 强制隔离条件

- 资源名必须以 `task88-restore-` 加 UTC 时间戳开头；
- 临时目录必须解析到 `/var/tmp/task88-restore-*`；
- 复用服务器已存在的 `postgres:16` 镜像；镜像缺失时停止，禁止自动 pull；
- 源备份只读挂载；
- `--network none`；
- 不使用 `-p` 或 `--publish`，host port bindings 必须为空；
- 不传生产 `.env`、`DATABASE_URL`、生产数据库名、生产容器名或生产 volume；
- 目标数据库固定为 `task88_restore`；
- 只做版本、schema、migration 数量、表数量等非敏感验证；
- cleanup 只删除本次经过精确名称核验的临时容器、volume 和目录。

### 6.2 执行流程

1. 运行每日健康检查，确认最新备份 checksum 和 gzip 均通过。
2. `docker image inspect postgres:16`；不存在则停止。
3. 生成唯一 drill ID、容器名、volume 名和 `/var/tmp/task88-restore-*` 目录；逐项校验前缀和绝对路径。
4. 记录生产 API/Web restart count 和公网 health 基线。
5. 启动临时 PostgreSQL 16：
   - `--network none`
   - 无 port publish
   - 唯一临时 volume
   - 源备份 bind mount 为 `readonly`
   - 非生产目标数据库 `task88_restore`
6. 用 `pg_isready` 等待临时数据库 ready。
7. 在宿主机只读解压源备份，并通过 stdin 恢复到临时容器；`psql` 必须使用 `ON_ERROR_STOP=1`。
8. 只记录：
   - PostgreSQL server version；
   - public schema 表数量；
   - migration 表是否存在及已应用记录数量；
   - restore exit code 和耗时。
9. 不查询或输出任何业务行。
10. 精确停止并删除临时容器和 volume；校验目录绝对路径后删除临时目录。
11. 确认临时资源均不存在。
12. 再次确认生产 Nginx/Docker/PostgreSQL active、failed units=0、API/Web restart count 与公网 health 未变化。

任一隔离条件不能证明时，不执行恢复。任一 restore、验证或 cleanup 失败时，结果为 Fail，不得写成 Pass。

## 7. 证据与保留

每次每日检查只保留脱敏结构化摘要。每次月度演练必须填写模板，记录执行人、审核人、source backup、生成时/实际 checksum 比对结果、隔离参数、非敏感验证、cleanup 和演练后生产 health。

不得把以下内容写入文档或 Git：

- 真实 `.env`、数据库 URL、密码、token、session、cookie、secret、私钥；
- 备份文件、dump、CSV、原始日志、原始 production evidence；
- 业务明细或可识别个人数据。

故障升级角色：

- Operations owner：timer、service、磁盘、Docker 和演练执行；
- Data owner：备份可用性、恢复点和数据保全判断；
- Application owner：应用 backup/restore record 同步；
- Release owner：release gate 与发布影响判断。
