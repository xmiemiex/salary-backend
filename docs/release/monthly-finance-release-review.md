# 月度财务发布审核（2026-09-06）

结论：**可申请上线**。这是发布准备结论，不是生产已部署或财务独立对账通过。本轮修复 PP 成功提交的中断窗口，完成定向测试、8 项升级演练、旧版客户端兼容检查及 Node 22 生产镜像构建。唯一候选入口是 `tmp/monthly-finance-release-review/manifest.json`；其中记录提交、源码包 SHA256、镜像和证据校验值。其他 monthly-finance 发布目录均为历史证据，禁止从旧 manifest 选包。

## 代码审核及修复

- PP 原来先删除进度再完成任务；现在完整扫描进度保留到执行器事务中，与任务成功、审计一起提交。审计失败使任务状态和进度删除同时回滚。进程在适配器完成后退出，新任务读取末尾检查点，不重新请求交易页。
- 成功、失败都要求任务仍为 running、相同 leaseOwner、相同 attemptCount，且租约未过期。数据库测试覆盖同一执行器的旧代次、过期代次及事务失败后恢复。
- 页进度写入锁定当前任务并检查数据库时钟租约；只有整页处理完才保存。半页失败不推进检查点，重放依赖事件 ID 幂等；跨页去重集合及金额累计随检查点保存。新手动任务可以复用同月、同凭证范围的进度。
- 范围指纹含解析后的凭证、计划日期、月份和页大小，凭证变化不复用旧进度。当前月恢复采用原 coverageStartedAt 冻结请求截止，不随重试时间扩大。预览、局部请求和历史 60 卡模式不提供全月完成证明。
- 续跑是供应商分页响应的续跑，不是供应商不可变快照。分页排序/历史数据在扫描期间变化仍依赖后续完整刷新与对账发现；不能宣称独立 Portal 对账通过。扫描期间不应变更归属或排除规则；当前指纹不包含这些业务规则版本，变更后应完成一次全新整月刷新再验收归属。

测试证据位于同一 review 目录：unit-tests.log（61 项）、database-tests.log（2 项真实 PostgreSQL）、finance-tests.log（14 项真实 PostgreSQL）；合计 77 项通过。新增检查覆盖成功末尾中断、事务回滚、旧代次和过期结果。此前全量 522 项通过为历史证据，本轮没有声称重跑全量或真实整月 API。

## 八项迁移与回退边界

演练从生产基线的 19 项迁移开始，在随机隔离 schema 创建 4 条最小人工费用数据和一个锁定月，再运行 8 项迁移；结束只删除该随机 schema。可复现脚本：`scripts/monthly-finance-migration-review.cjs`，结果 `migration-evidence.json`。

| 迁移后缀 | 影响与审核结果 |
|---|---|
| monthly_finance_refresh | 新增可空员工统一 SUB、唯一索引、月费率/批次表及可空任务批次字段；原员工不被猜填 |
| inventory_checkpoint | 新增库存完成检查点表 |
| monthly_write_lock | 新增事务级锁及月锁触发器；旧端点也受锁定月份约束 |
| adpos_monthly_fee_consistency | Adpos 新增/修改时使用已配置月费率重算实际费用；旧应用回退后仍受此规则约束 |
| preserve_unambiguous_adpos_rates | 只迁移唯一且金额一致的已确认历史费率；测试锁定月成功保留，冲突/不一致月份留空；4 条原记录逐字段未变；临时停用触发器在事务内重新启用 |
| guard_inflight_financial_writes | 收入和卡支出写入也受月锁保护 |
| resumable_inventory | 新增库存续跑状态表 |
| transaction_page_resume | 新增 PP 月度页进度 JSONB 表，初始为空 |

以生产源码提交 `f859d79c2b8ff0aa380c5af86cc833fae7d3671e` 重建旧 API，实际运行其旧生成 Prisma 客户端读取员工、更新未锁月人工费用，并加载旧结算服务成功。不是生产镜像逐字节复刻，也不是旧版完整 HTTP 回归。

迁移无删表删列，**推荐回退应用镜像并保留新增 schema**。回退不会撤销已确认人工调整、费率回填、触发器的金额重算或新录入 SUB。不能通过盲删新表/触发器达到无损回退。若确需数据库时间点恢复，会丢失备份后的业务写入，必须另行审批恢复范围；本轮未恢复生产数据库。

## 构建和证据链

实际执行 API/Web 生产 Dockerfile，构建阶段 Node 22，API runtime 实测 `v22.23.2`。API 镜像 `sha256:35f5347ec766090b8d58def57e64cb25c06e2e993abfaa688164eac9048c2c98`；Web 镜像 `sha256:a0acbe1437a07b90a722125895ee1ec0a8fdf6df9b4239f565556729e144146f`。构建日志 docker-api.log、docker-web.log；.dockerignore 排除私有 .env、tmp、node_modules 和数据库备份。

生产当前静态入口 `/assets/index-DSS4Lz-1.js` 中实际读到 `https://api-salary.lovemiemie.com`；新 Web 镜像构建参数及产物均为此地址。旧 localhost:3050 浏览器构建只保留为历史页面验收，不是本次生产 Web 镜像。

历史实际整月证据 applicationCandidate 为 1224124；到 aabaebf 的差异仅两份文档及四份测试/证据脚本，没有应用或 Prisma 变更。本轮有应用修复，因此重新构建 Node 22 镜像和新源码包，不能沿用 aaba 包作为最终候选。新后端变化不涉及页面结构，保留既有 1366/1440/1920 浏览器证据并明确其历史提交。

`final-snapshot.json` 是本轮只读数据库/服务快照：六来源 completed，refreshing=false。旧 http-latest-evidence 已改为显式失效指针，指向该快照和已提交的完整真实联调证据；没有把数据库快照伪称为新 HTTP 测试。

## 生产现状及上线步骤

生产现状复用 2026-09-05 的实际只读证据：旧 API/Web 均为 `task102-f859d79c2b8f`，19 项迁移，计划器和定时自动执行均 false。本輪新读仅核对线上静态入口与 API origin；镜像/数据库/备份未冒称刚刚重新读取。现有网站、仓库、网络、配置路径均保留。

已有成功备份记录：2026-09-05 02:22:16–17 UTC，加密，544177 bytes，SHA256 `ecd1b7f7c96a709b08c92b4fb9d8f4c69bb3f2dea568bf033ea914f9421ff2bc`；最新成功恢复演练记录为 2026-07-27。本轮只读记录，没有重新验证备份文件或再次做恢复演练。

1. 用户批准 manifest 指定候选及维护窗口。上线操作员再次核对当前镜像仍是下列精确基线、迁移仍为 19 项、两个自动开关仍 false；若环境漂移，停止并重新审核差异。
2. 使用既有 `/opt/salary-settlement-admin/releases/<candidate>` 解包已校验源码；继续使用 `/opt/salary-settlement-admin/shared/.env`，不得用本地 .env 或隧道配置。核验最近成功备份的真实文件与校验和可用。这是上线执行门槛，记录成功不能代替文件校验。
3. `scripts/monthly-finance-production-release.sh` 默认 plan。明确批准后设置其提示的候选 tag、源码包 SHA、备份文件/SHA，才运行 deploy-approved。先构建镜像，后停止 API/Web 写入，再运行 migrate deploy，成功后原 compose 项目启动新镜像。脚本语法及 plan 路径已检查，生产分支未执行。
4. 影响窗口从 compose stop 到健康检查/正式域名验收结束；本轮无生产计时，不能承诺固定分钟数。迁移涉及现有财务表触发器及锁，应选择无在途同步、无财务编辑的维护窗口。迁移失败保持应用停止，检查实际迁移状态后决定恢复，禁止自动向下迁移。
5. 正式域名验收：ready/healthz、登录、权限、月份切换、五列大盘、明细分页；经业务确认后验证刷新与去重、失败保留旧数、统一 SUB、真实月费率、CAKE 已确认加减记录保留、锁定月份拒绝写入。不可用测试费率完成真实结算。

回退触发：API/Web 启动失败或持续不健康、登录/权限回归、月锁失效、费用/收入重复或金额口径异常。先停止业务写入；若仅应用问题且迁移已成功，运行 rollback-approved 恢复下列旧镜像，并保留 schema；随后验证 ready、登录、只读工资页面。若迁移或数据已损坏，应先核对迁移状态/审计，再申请备份恢复，不能继续刷新掩盖错误。

| 服务 | 精确回退镜像 |
|---|---|
| API | salary-settlement-api:task102-f859d79c2b8f / sha256:6f940a27f83b5d9e1ee40c726c2accfdb2a0350bf2bd6bb7c57e4ce1253a63bf |
| Web | salary-settlement-web:task102-f859d79c2b8f / sha256:7a13601d4578ab54a082372955cb25dcbc9d86ab264d96f7022dd6e1af52083c |

## 业务待办与审批范围

CAKE 原生收入 + 已确认人工加减是已确认规则，时区不构成阻塞。实际 2026-08 三类月费率仍空；需用户填写真实费率才能得到完整 ROI。当前展示有 2 条待统一行（脱敏 P01/P02，各 0 个可推导原 SUB），应在大盘统一 SUB 入口人工填写，不能猜填；其他无歧义回退按既有规则显示。独立 Portal 月报未取得，结论仅包含实际 API 全月一致性及重刷幂等，不能标注独立财务审计通过。

本次可审批的是：选定新候选、在既有站点维护窗口升级、按以上门槛复核与验收。未授权生产执行，未新建站点或仓库，未改生产业务配置。
