# 月度收支与统一刷新：本地交付及生产升级准备

本次仅交付本地版本与发布准备。未连接或修改生产数据库，未部署生产。历史起点为 `f859d79c2b8ff0aa380c5af86cc833fae7d3671e`；这不代表现在的生产版本。候选精确提交及源码 SHA256 见 `tmp/monthly-finance-release/manifest.json`。

## 本地评审

- Web：`http://localhost:5189/dashboard`；API：`http://localhost:3049`。
- 独立 PostgreSQL 16.8：`monthly-finance-31e3-postgres-1`，端口 35439，数据库 monthly_finance；未更改其他项目的容器、volume、数据库。
- Node 24.19.0、仓库锁定 pnpm 10.32.1；生产 Dockerfile 继续使用 Node 22 Alpine。
- 随机登录信息仅保存在忽略的 `tmp/monthly-finance/login.json`，评审浏览器已自动登录。没有配置任何真实第三方凭据。
- 2026-09 是明确标识的本地模拟样例：三个联盟收入 2000/3000/5000，AW 1000、PP 2000、Adpos 1000；当前评审费率 3%/3%/3.5%，含费 4125、毛利 5875、ROI 142.42%。另有隔离数据库测试使用 3%/5%/2% 验证 4150/5850/140.96%；测试不会覆盖评审输入。
- 最新截图位于 `tmp/monthly-finance-rework/`：dashboard-1366、dashboard-1440、dashboard-1920、details-page-2（PNG）。浏览器验收使用临时 schema、8 名员工及 6 个联盟，构建 Web 5190/API 3050，结束后清理。截图中的来源失败表示没有真实凭据，不表示真实服务商故障。

实际操作：选择月份 → 刷新数据 → 查看来源进度和统一 SUB ID 行。通过“本月手续费”填写或复制上月并保存；Adpos 点击“编辑”后保存/取消；金额点击打开同页明细。多联盟原始 SUB ID 在明细中可设置一个统一 SUB ID，不需要重新录入联盟映射或成本分配。

## 账目与兼容

- `employees.business_sub_id` 为可空唯一标识。只有一个有效原始 SUB ID 时直接识别，多值且未统一时明确提示，不取第一条、不重复分配成本。
- 收入读取全部 confirmed IncomeRecord，保留手工收入及已确认 CAKE 调整。动态列用联盟名称，不用 Everflow/CAKE 系统类型冒充联盟。
- 成本读取现有 confirmed CardSpendEvent 的实际 spendUsd；原交易币种、GMT+8 消费月份、PhotonPay 别名、测试卡排除、实际 USD 本金与历史专项回填限制均保留。
- API 费率继续用原月费率表；Adpos 用独立月费率表，与工资读取共享月费率。数据库触发器确保旧手工入口不能覆盖已配置的 Adpos 月费率。费用编辑不会触及其他月份。
- Adpos 月总额编辑保留已有手工条目，通过一个受审计的调整条目更新聚合总额，API 同步不会写该条目。
- 已有其他手工平台花费仍计入合计，页面提示并可查明细。缺费率不默认为零；有花费但缺费率时不展示最终毛利，也不能生成最终工资。
- 工资分组、提成、考勤、补贴、个人历史亏损抵扣等规则未改变。

## 主动刷新后台路径

`POST /dashboard/monthly/refresh` 在 PostgreSQL 事务内创建批次及原有 sync_tasks，快速返回。活动批次复用，短时间重复请求也复用。前端定期查询持久化状态，重载恢复；可以只重试失败来源。

DashboardRefreshWorker 随现有 Nest API 启动，每 2 秒检查明确由按钮提交的批次，只消费 `manual + refresh_batch_id`，复用原租约、审计、失败分类和重试执行器。无需新增 worker 服务、端口、systemd、cron 或开启月度自动调度。生产继续保持 `SYNC_PLANNER_ENABLED=false`、`SYNC_AUTO_EXECUTION_ENABLED=false`，Webhook 不变。

默认最多 2 个活动任务；单请求 30 秒；任务网络执行预算最多 10 分钟且短于租约。每来源请求间隔至少 250ms；超时、429、5xx 等按原最大 3 次策略退避，业务错误不会无限重试。领取与执行解耦，慢 A 不阻塞 B 完成后 C 在下一次两秒轮询补位；全局活动租约计数和同来源互斥约束仍生效。API 重启后 pending 继续消费；未达上限过期租约恢复，达上限过期 running 自动收口为 failed 并可重新提交，失效凭据/锁账会终止待执行任务。不会以 Promise.race 放弃仍在写账的任务。

Airwallex 首次卡发现仍从 2018-01-01 完整遍历。仅全部分页及归属处理成功后保存凭据绑定的发现游标；后续发现重叠 1 天并保留、重新匹配旧卡。凭据变化重新全扫。分页不完整不推进游标，也不删旧卡；新增 provider_inventory_scans 保存凭据指纹、固定扫描终点、窗口/页码及卡/持卡人阶段的必要脱敏资料；每成功页保存进度。中断续跑从已保存页继续，归属写入可幂等重做。完整游标与进度清理在同一事务。首次发现若达到期限会有限重试，最终失败后单源重试仍复用进度，不从 2018 重新开始。消费适配器自身衔接卡发现，大盘不再额外全扫。

只有四种正式月度适配器完成全来源查询与所有写入后，才生成 monthlyCoverage 证据。预览、校准、短窗、目标卡子集以及未知请求选项均不给出整月证明。大盘忽略后续无关预览，保留较早正式成功的时间。查询时间与来源覆盖时间分别展示；旧 completed 缺少证明时显示不完整，需要正式重刷验证。

汇总由数据库 groupBy 完成；刷新使用轻量状态接口，来源状态变化才重取汇总；明细按来源从服务器每页读取 20 条。

旧卡绑定页同步入口同样返回持久化批次，不再长时间阻塞 HTTP；卡发现专用任务不被当成月消费成功。页面明确“提交”不等于“完成”。

## 本次验证

- 返修测试与验收详见 [返修进度](monthly-finance-rework.md)。最终日志为 `tmp-monthly-rework-*.log`；前端构建保留已有 bundle 大小和依赖 use-client 提示。
- PostgreSQL 专项 12 项通过，其中 11 项使用真实 PostgreSQL，1 项为 Decimal 单测；供应商均为模拟。新增覆盖证明、慢源补位、最终中断、AW 分页跨实例恢复和规模测试。
- 100 员工/300 收入/50,000 消费事件，五次查询 34–53ms，汇总 49,721 字节、状态 847 字节、明细 2,332 字节。本地测量不能替代生产容量测试。
- `scripts/monthly-finance-rework-browser.cjs` 使用临时 schema，不再通过旧脚本覆盖评审费率。验收记录提交、干净工作区状态、API/Web 构建树哈希；发布脚本拒绝不同提交或未提交状态的截图证据。
- Task101 的五个已有截断索引名仍用 Prisma map 对齐，未重命名或删除索引。
- 未进行真实服务商月度对账、生产域名点击或历史 60 卡逐笔验收。任务103未完成的历史三方集合证据不在本次声明为完成。

## 既有生产环境升级流程（仅在后续授权发布任务执行）

1. 在现有 DigitalOcean 主机通过既有 SSH/Tailscale 路径核验实时 release tag、API/Web 镜像 digest、运行提交、当前迁移及并行任务改动。记录回滚版本。不要直接复用归档 runbook 的 `rc-20260712-2`、旧 Full Go 或旧迁移数量。
2. 核验本候选源码归档及 manifest 的精确 commit/SHA256，与产品验收的版本一致。打包脚本只允许已提交干净工作区；归档不含 `.env`、登录文件或本地模拟数据库。
3. 保留既有服务器环境文件 `/opt/salary-settlement-admin/shared/.env`、加密密钥、数据库连接、联盟凭据、别名、排除卡及映射。Web 用现有正式 API HTTPS origin 构建，不用 localhost。Compose/API 3000、Web 8080 继续只绑定 loopback，沿用现有 Nginx/Cloudflare/TLS、外部网络及主机 PostgreSQL。
4. 用现有备份机制完成并验证本机加密全量备份；保存回滚镜像、配置、提交和校验信息。当前任务不扩展对象存储/异机备份。
5. 迁移前只读检查历史 confirmed Adpos：各月费率是否一致，实际花费是否等于原始花费乘费率。第五个迁移只自动保留精确一致的月费率；多费率或异常金额的历史月份不会被猜测合并。若存在这类数据，先形成保留原账的评审方案，不能宣称历史数据迁移已无缺口。
6. 使用当前 `docker-compose.prod.yml` 与两个 Dockerfile 生成不可变镜像，记录 digest。API 内置主动 worker 不新增进程。核验两个自动调度开关仍 false。
7. 执行七个候选迁移（名称见 manifest）。沿用 Task101 已有方式：一次性 API 容器挂载候选 `prisma/` 到 `/app/prisma` 只读、使用现有 server env、现有网络与 host 映射运行 Prisma migrate deploy。运行时镜像本身不包含 migration 目录，不能漏挂载。再次要求 pending=0、schema diff=0。
8. 用既有 rollout 流程替换 API/Web 镜像，健康检查通过后保留原域名与 Nginx 路由。无需延长代理超时。收集 3000 health/live、health/ready、8080 healthz、正式 HTTPS Web/API 及 restart 计数证据。
9. 通过正式域名登录已授权账号，选未锁月份点击一次刷新：请求快速返回、来源逐个完成/失败、关闭重开恢复。记录失败来源原因及上次成功时间；未配凭据和未同步不计为成功。核验 Adpos 与费率不被刷新覆盖、并发点击不重复、单源重试、0%与缺失费率、锁账403/业务拒绝、业务金额与工资口径。全流程不要求用户重新录入已有凭据或历史账目。

## 回滚

先停止接受新的刷新并停止候选 API，保留 pending/running 批次与审计证据，再恢复发布前已记录的不可变 API/Web 镜像和 server env。不要删除新增表、统一 SUB 字段或批次；旧应用忽略它们。已保存的 Adpos actualSpendUsd 保留，旧工资仍可读取；月费率一致性/锁账触发器保留保护。

如果旧应用与新增触发器存在经验证的行为不兼容，单独评审数据库回滚脚本，先导出新增月费率及人工变更，再有序处理触发器和表。不要自动逆向 DDL，更不要将整库恢复当作普通代码回滚。全量恢复仅用于确认的数据完整性事故并另行授权。

## 官方接口核验来源

- [Airwallex 卡列表](https://www.airwallex.com/docs/api/2020-04-30/issuing/cards)：不提供起止时间会默认30天；零起始页码、10–200每页、创建时间过滤。因此首次发现保留全历史，分页必须完整。
- [Airwallex 交易说明](https://www.airwallex.com/docs/issuing/transactions/retrieve-card-transactions) 与 [当前交易 API](https://www.airwallex.com/docs/api/issuing/transactions)：与仓库现有 transactions 路径核对；没有切换成不同契约的 bookmark card_transactions API。
- [Everflow Affiliate 汇总](https://developers.everflow.io/api-reference/post-affiliatesreportingentitytable)、[限流说明](https://developers.everflow.io/user-guide/rate-limiting)：保留现有 timezone metadata、SUB 汇总及 incomplete_results 拒绝逻辑。
- [CAKE Affiliate SubAffiliateSummary](https://getcake.freshdesk.com/support/solutions/articles/13000119010--reports-subaffiliatesummary-v1-affiliate)：保留账号特有域名、Affiliate API 和校准保护，不拿 Admin API 替代。
- [PhotonPay 官方入口](https://api-doc.photonpay.com/) 是动态文档，文本抓取未返回接口正文；本次保留 Task102 已记录并验证的 v4 pagingVccTradeOrder、txnPrincipalChangeSettledAmount、USD 本金与专项回填约束，不虚构新的接口能力。真实账号联调仍需后续授权环境验证。
