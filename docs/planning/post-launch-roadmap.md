# 任务95：上线后路线图与技术债盘点

审计日期：2026-07-30
审计边界：仅使用 Git 已跟踪文件和 Git 元数据；未连接生产、未查询生产数据库、未读取原始 Evidence。

## 1. Git 与证据基线

| 项目 | 核对结果 |
| --- | --- |
| 分支 | `main` |
| 起始 HEAD | `775a4c2b2b1de010fab056bc2281802a9abdb700` |
| 起始 `origin/main` | `775a4c2b2b1de010fab056bc2281802a9abdb700` |
| RC 标签 | `rc-20260712-2` |
| RC 标签对象 | annotated tag `d814634e3282cc3226e23ca23270c34a871359ca` |
| RC 解引用 commit | `9f8f8f576dde54355983b96525335e94c55c8b32` |
| 既有未跟踪项 | `release-staging-task80-20260721T1225/`；只确认目录名，未读取、修改或计入证据 |

生产基线沿用已跟踪文档的权威结论：
`Full Go stable with accepted backup risk`。任务94后最新一次已记录 Gate 为
`36 pass / 1 warning / 0 fail`，唯一 warning 是
`E2E_PERMISSIONS_RECENT_RUN`；这不改写任务86的 stable 收口，也不能写成当前全绿。

## 2. 实际读取范围

已读取或用 `git grep`/`git ls-files` 检查的 Git 已跟踪范围：

- `docs/operations/`：生产风险台账、生产监控 Runbook、运维交接、备份恢复 SOP、
  月度恢复模板。
- `docs/release/`：生产审批记录、上线后监控报告、RC、审批包、发布 Runbook、
  回滚计划、上线后清单和目录说明。
- `README.md`、`docs/development.md`、`docs/initialization-plan.md`、
  `docs/database-migration-baseline.md`、业务规则和测试用例文档。
- 根目录和 workspace `package.json`、`pnpm-workspace.yaml`、CI workflow。
- `prisma/schema.prisma` 和全部已跟踪 migration 文件名/相关 SQL。
- `apps/api`、`apps/web` 中已跟踪的 TODO/FIXME、明确未实现/兼容标记、核心页面、
  controller/service、测试清单。
- `deploy/scripts/`、`deploy/systemd/`、部署架构和 Runbook 中的 task 专用、长期入口、
  retention、sudo、告警与 Evidence 逻辑。
- 2026-07-20 后 `main` 的生产相关提交标题；任务90至94的实现和收口提交均已覆盖。

未读取：

- task80 未跟踪目录内容；
- `.env`、key、备份、dump、CSV、原始日志、原始 Evidence、生产凭据；
- 任何未跟踪或被 `.gitignore` 排除的敏感内容；
- 生产服务器和生产数据库。

## 3. 审计结论摘要

- 没有 P0。已跟踪证据没有显示当前生产阻塞或高概率严重事故。
- 共有 10 个有证据的候选项：7 个 P1、3 个 P2；没有 P3 候选。
- 代码中没有字面 `TODO` 或 `FIXME`；真实债务主要存在于显式
  `not_implemented`/兼容逻辑、Runbook 长期技术债、task 专用生产脚本和缺失的生命周期策略。
- 菜单中没有实际落入 `PlaceholderPage` 的现行路由；不能据此虚构“复杂前端页面尚未实现”。
- 下一任务只推荐一个方向：生产低权权限 Smoke 身份与 Evidence 生命周期长期化。

## 4. 候选项优先级

评分均为 1–5；成本和变更风险分数越高，实施越难或越危险。

| ID | 分类 | 候选项 | 用户价值 | 业务紧迫度 | 风险降低 | 实施成本 | 变更风险 | 优先级 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| C-01 | 安全/可靠性 | 生产低权权限 Smoke 身份与 Evidence 生命周期长期化 | 3 | 5 | 5 | 4 | 4 | **P1；唯一任务96** |
| B-01 | 可靠性/运维 | 长期告警处置 SOP：升级、值班、确认、恢复、复盘 | 3 | 4 | 5 | 2 | 1 | P1 |
| C-02 | 安全/数据 | 数据库层强制 `audit_logs` 不可更新/删除 | 2 | 3 | 5 | 4 | 4 | P1 |
| C-03 | 安全/工程 | 依赖、镜像和供应链安全扫描及补丁节奏 | 2 | 3 | 4 | 3 | 2 | P1 |
| A-01 | 产品能力 | 基础资料页关联字段改为可搜索业务选择器 | 5 | 4 | 3 | 3 | 2 | P1 |
| A-02 | 产品能力 | 数据同步任务状态、提示和未匹配入口一致性收口 | 4 | 3 | 3 | 3 | 3 | P1 |
| E-01 | 工程效率 | 补齐关键 Web 业务页行为测试 | 3 | 3 | 4 | 3 | 2 | P1 |
| D-01 | 数据/数据库 | 运营数据表保留、归档和容量策略 | 2 | 3 | 4 | 5 | 5 | P2 |
| B-02 | 可靠性/运维/工程 | 生产运维资产长期化、归档与保留策略 | 2 | 3 | 4 | 4 | 4 | P2 |
| E-02 | 工程效率 | 配置兼容与开发/架构文档漂移收口 | 2 | 2 | 3 | 3 | 2 | P2 |

## 5. 候选项证据与建议边界

### C-01 生产低权权限 Smoke 身份与 Evidence 生命周期长期化

- 证据：
  - `docs/operations/production-handoff.md:55` 明确列为“下一维护窗口”。
  - `docs/operations/production-runbook.md:119-129` 显示当前流程复用
    `task84_permission_smoke`，需要可见 SSH 中输入 super_admin 凭据。
  - `docs/release/post-go-monitoring-report.md:260-266`、`:317-323`、`:347-356`
    显示任务92、93、94连续出现唯一 `E2E_PERMISSIONS_RECENT_RUN` warning。
  - `deploy/scripts/production-permissions-smoke-helper.js:6` 硬编码 task84 用户名。
  - `deploy/scripts/production-permissions-smoke.sh:111-118` 依赖人工 super_admin 登录；
    `:150-229` 临时重置密码、启用账号、执行 401/403、logout-all、再禁用。
- 业务影响：Gate 会在真实权限 Evidence 超过 24 小时后反复失去全绿，运维需人工返修。
- 生产/安全风险：涉及 super_admin 会话、低权账号短时启用、密码重置和生产 Evidence 写入；
  失败时必须保证账号 disabled、session 撤销、临时凭据清理。
- 依赖：Security、Application、Operations、Release owner；现有权限脚本和 Gate 语义。
- 生产操作：**需要**，但只允许在任务96单独授权窗口安装/验收；本任务不执行。
- Migration：**不需要**；建议禁止在任务96顺带改 schema 或角色模型。
- RC：不移动或重写 `rc-20260712-2`；实现属于 RC 后的新版本/运维工具。
- 范围：稳定化 smoke 身份/最小角色、凭据交互边界、Evidence TTL 与刷新责任、失败清理、
  预到期提醒、脚本测试和 Runbook；不改变权限模型。
- 验收：见第8节唯一任务96建议。

### B-01 长期告警处置 SOP

- 证据：`docs/operations/production-runbook.md:60-66` 明确列出长期告警 SOP 债务；
  `apps/api/src/alerts/alerts.controller.ts` 已提供 scan/acknowledge/silence，
  `apps/api/src/alerts/alerts.service.ts` 已提供稳定 fingerprint、自动恢复和审计，
  但通用值班、升级时限、确认责任、复盘和超时处置未形成单一长期 SOP。
- 业务影响：告警能生成不等于有人按统一时限处置；值守责任不清会延长故障暴露时间。
- 生产/安全风险：文档和流程变更风险低；若后续增加外部通知渠道，必须单独评估凭据。
- 依赖：Operations、Security、Application/Data owner。
- 生产操作：纯 SOP 阶段不需要；自动通知阶段另行授权。
- Migration：不需要。
- RC：不影响。
- 范围：覆盖通用告警的 owner、值班、确认、静默、升级、恢复、复盘和演练，不新增外部
  通知渠道或凭据。
- 验收：每类 critical/warning 有 owner、SLA、ack、升级、恢复、复盘、演练和审计规则；
  与备份 SOP 不矛盾。

### C-02 数据库层强制审计日志不可变

- 证据：`docs/business-rules/data-model.md:69-74` 明确建议撤销应用用户对
  `audit_logs` 的 `UPDATE/DELETE` 或增加拒绝 trigger；现有 migration 只创建表和外键，
  未找到对应 `REVOKE` 或 trigger。
- 业务影响：应用 API 当前没有普通修改/删除入口，但数据库凭据被滥用时仍缺第二道保护。
- 生产/安全风险：高；错误授权可能阻断正常审计写入或运维调查。
- 依赖：Data owner、Security、Application owner；先核对生产 role/owner 权限模型。
- 生产操作：需要受控数据库变更和回滚演练。
- Migration：**需要**，应使用单独、可审查的 migration 或等价受控权限变更。
- RC：不修改现有 RC；需新发布/数据变更审批。
- 范围：仅强化 `audit_logs` 数据库写保护和必要的角色权限，不改变审计字段、普通查询或
  导出产品功能。
- 验收：应用仍能 INSERT；应用 role 的 UPDATE/DELETE 被数据库拒绝；管理员维护边界明确；
  失败审计和 release gate 不回归。

### C-03 依赖、镜像和供应链安全扫描

- 证据：`docs/operations/production-runbook.md:66` 和
  `docs/operations/production-handoff.md:60` 要求固定补丁节奏；当前唯一 CI workflow
  运行构建/测试/门禁，但未发现依赖漏洞、CodeQL/SAST、镜像漏洞或 provenance 扫描；
  `pnpm-lock.yaml:2009,2014` 还记录了旧 `glob` 的公开安全漏洞弃用警告。
- 业务影响：安全更新依赖人工发现，缺少可追踪的漏洞准入和例外机制。
- 生产/安全风险：CI-only 初期风险低；自动升级必须避免未经验证直接进入生产。
- 依赖：Security、Engineering、镜像构建流程和 GitHub Actions。
- 生产操作：不需要。
- Migration：不需要。
- RC：不修改 RC 标签；新门禁只适用于后续变更。
- 范围：后续提交和镜像的依赖漏洞、SAST/供应链报告、严重度阈值、例外到期与补丁节奏；
  不自动升级生产依赖。
- 验收：锁定扫描工具/严重度阈值、生成可审计报告、验证无 secret、定义例外到期和月度补丁
  节奏；高危结果能阻止后续发布而不伪造当前事故。

### A-01 基础资料关联字段改为可搜索选择器

- 证据：`apps/web/src/pages/BaseDataPages.tsx:101-237` 的多项运营表单要求直接输入
  `defaultEmployeeId`、`affiliateAccountId`、`employeeId`、`configId`；同仓库
  `SyncReconciliationPage.tsx` 已证明员工/联盟账号可使用带名称和编码的可搜索 Select。
- 业务影响：人工复制 UUID 容易误选，增加运营录入成本和校验失败。
- 生产/安全风险：低；主要风险是选项分页、权限过滤和禁用对象误选。
- 依赖：现有员工、联盟账号、工资项配置查询 API；需要确认大数据量分页策略。
- 生产操作：需要常规 Web 发布，不需要独立数据写入窗口。
- Migration：不需要。
- RC：不修改现有 RC；属于下一应用版本。
- 范围：优先覆盖 `employeeId`、`affiliateAccountId`、`configId` 等现有关系字段的查询、
  展示、分页和提交，不扩展新的业务实体。
- 验收：关联字段展示业务名称/编码、提交仍只发送 ID；搜索、分页、禁用态、无权限和空结果
  有测试；不能泄露无权查看的对象。

### A-02 数据同步状态与未匹配入口一致性

- 证据：
  - `apps/api/src/sync-tasks/sync-tasks.service.ts:20-21,107,140` 新建人工任务仍写
    `not_implemented` 和“真实接口未接入”，但
    `sync-task-execution.service.ts` 与 `sync-adapter-resolver.ts` 已连接 Everflow、CAKE、
    Airwallex、PhotonPay 真实 adapter。
  - `apps/api/src/sync-reconciliation/sync-reconciliation.service.ts:12,277` 仍返回旧的
    “adapter 跳过未匹配记录”限制；现有 adapters 和
    `sync-unmatched-events` 已记录、展示和处置未匹配事件。
- 业务影响：运营人员可能把可执行任务误判为未接入，并在两个未匹配入口间看到冲突口径。
- 生产/安全风险：中；不能把历史任务状态批量改写为成功或自动执行。
- 依赖：同步任务、四个 provider adapter、未匹配事件页、锁账和凭据门禁。
- 生产操作：需要 API/Web 常规发布；不得在任务96之外调用真实 provider。
- Migration：建议不需要；历史状态保持历史事实，不做批量回填。
- RC：不修改现有 RC。
- 范围：仅收口新建任务状态/提示、人工执行语义和未匹配权威入口；不启用自动执行、不调用
  provider 验收、不批量改写历史任务。
- 验收：新任务状态/文案与真实执行语义一致；唯一权威未匹配入口明确；历史记录不伪造；
  disabled 自动执行开关时不发起第三方请求。

### E-01 关键 Web 业务页行为测试

- 证据：`apps/web/package.json` 当前只串行运行 13 个测试文件；未见
  `BaseDataPages`、`SalarySettlementPage`、`SyncReconciliationPage`、
  `SyncUnmatchedEventsPage` 的页面级行为测试。API 有 62 个已跟踪 spec，覆盖明显更深。
- 业务影响：结算、录入和核对 UI 的回归可能在 API 测试通过后进入构建。
- 生产/安全风险：仅测试变更风险低；测试不得访问真实 provider 或生产。
- 依赖：Testing Library/jsdom、现有 apiClient mock、权限 actor fixture。
- 生产操作：不需要。
- Migration：不需要。
- RC：不影响现有 RC；提高后续版本准入。
- 范围：补齐现有关键 Web 页面的行为回归和 CI 接入；不借测试任务改变业务规则或生产 fixture
  边界。
- 验收：覆盖成功、校验失败、401、403、锁账、权限按钮、关联选择、敏感字段阻断和 API
  payload；接入统一 `pnpm test`/CI。

### D-01 运营数据表保留、归档和容量策略

- 证据：`prisma/schema.prisma` 中 `AuditLog`、`Alert`、`Notification`、
  `AdminSession`、`BackupRecord`、`RestoreDrillRecord` 均持续增长；仓库搜索到的这些模型
  `delete/deleteMany` 只出现在测试/E2E cleanup，未发现生产保留任务。文档只明确备份文件
  30 天和恢复 Evidence 90 天，没有为上述数据库表定义统一保留期。
- 业务影响：长期运行后会增加存储、查询和合规处置压力；当前没有已跟踪证据证明已出现
  容量事故，因此不升级为 P1/P0。
- 生产/安全风险：很高；错误清理可破坏审计链、告警历史或恢复证明。
- 依赖：Product/Data/Compliance/Operations 先确定每类数据的法定和业务保留期。
- 生产操作：需要 dry-run、备份、分批执行、监控和停止条件。
- Migration：可能需要归档表、索引或作业表，按设计决定。
- RC：不修改现有 RC；需要单独数据变更审批。
- 范围：为审计、告警、通知、session、备份和恢复记录定义保留/归档策略、只读容量基线、
  分批作业和 legal hold；不改变备份文件 30 天策略。
- 验收：先输出只读计数/age 分布和预计释放量；按表定义保留/例外/法律保全；批次幂等；
  不删 active alert、有效 session、有效恢复 Evidence；可停止、可审计、可恢复。

### B-02 生产运维资产长期化、归档与保留策略

- 证据：
  - 34 个 deploy script 中有 12 个 task 编号文件；当前交接仍引用
    `/home/salaryops/task85-post-go-check.sh`，权限 helper 仍硬编码 task84，仓库保留
    `task82`、`task90`、`task93`、`task94` rollout。
  - `docs/operations/production-runbook.md:64` 明确要求清理/归档 release gate
    Evidence；`production-handoff.md:58` 只给出“按月或每次发布后”，未定义保留数量、
    上限、法律保全或删除审批。Task94还保留 root-only 回滚副本。
- 业务影响：长期值守入口与历史 rollout 混杂，维护者难判断权威入口；无限增长和超龄
  Evidence 误用风险同时存在。
- 生产/安全风险：中高；错误替换或删除可能破坏权威入口、回滚能力和审计证据，保留不足
  也可能占满磁盘。
- 依赖：先建立“当前安装入口、历史 rollout、仅证据复现”清单，并由 Release、
  Operations、Security/Data owner 确定保留与 legal hold 规则。
- 生产操作：仅仓库标注/归档不需要；替换已安装入口或首次执行清理需要单独窗口。
- Migration：不需要。
- RC：不修改现有 RC。
- 范围：稳定入口功能命名、一次性 rollout 分类、Evidence/日志/回滚副本 owner、保留期、
  容量上限、legal hold、dry-run、精确清理目标、失败停止和审计。
- 验收：权威入口、安装路径、hash、回滚和 Runbook 一致；历史脚本只读归档并标注不可
  复用；不删除仍被生产引用的文件；不得触及备份 30 天 retention 或 Accepted 风险。

### E-02 配置兼容与开发/架构文档漂移收口

- 证据：
  - `README.md:39` 明确仍兼容 `PORT`、`WEB_ORIGIN`、
    `AUTH_SESSION_TTL_HOURS`；`docs/development.md:75` 仍以旧变量为主，而生产模板和主
    README 已采用 `API_PORT`、`CORS_ALLOWED_ORIGIN`、`ADMIN_SESSION_TTL_SECONDS`。
  - `docs/initialization-plan.md` 仍称不包含 Docker Compose、真实同步、复杂页面和
    结算流程；当前仓库已包含 Compose、真实 adapters、完整业务页和结算服务。
    `deploy/production-architecture.md` 仍是任务78的 No-Go 计划，容易与当前 Full Go
    交接混淆。
- 业务影响：配置来源重复，增加环境漂移和排障成本；新维护者还可能按历史阶段误判当前
  能力。
- 生产/安全风险：中；直接删除兼容可能导致旧环境启动失败，错误更新文档可能把未验证
  生产事实写成完成。
- 依赖：先以 env check 证明受支持环境的变量使用情况；以当前代码、RC 和生产交接为事实
  基线，保留历史背景。
- 生产操作：纯文档更新不需要；最终删除兼容分支时需要常规发布和环境核对。
- Migration：不需要。
- RC：不修改现有 RC。
- 范围：统一配置变量表和弃用顺序；同步 README、开发、初始化和生产架构文档的当前/历史
  状态。
- 验收：兼容弃用告警和优先级/非法值测试完整；生产 env check 全绿后才能删除旧分支；
  历史计划与当前事实分栏、链接有效，不把未验证事项写成完成。

### 未来触发条件/观察项（不计入候选数量）

多实例共享登录限流移出当前候选任务表。证据仍是
`docs/development.md:90`：当前限流仅在单 API 进程内生效，而当前生产架构只有一个 API
容器、没有横向扩容决定。只有产品/架构明确决定横向扩容时，才重新进入排期，并在扩容前
完成跨实例一致限流、可信代理 IP、误封恢复和安全测试。

## 6. Accepted 风险与不投入项

| 风险/事项 | 状态 | 当前处理 |
| --- | --- | --- |
| RISK-DP-001 无异机备份 | Accepted / unresolved / non-blocking | 保持原决定；不列入任务96，不采购或配置 DigitalOcean Spaces/S3/对象存储 |
| RISK-DP-003 active/recovery 同盘同时损坏 | Accepted residual / non-blocking | 保持同机缓解；不在任务96扩展为异机 key 托管 |
| Droplet 整机损坏导致本机数据与备份同时丢失 | Accepted | 不改写为 No-Go，不重复开发 |
| 为保持 Gate 全绿而复制旧时间戳或伪造 Evidence | 不应投入/禁止 | 必须继续禁止；只允许生成新的真实 Evidence |
| 在 task95 清理历史脚本、Evidence、回滚副本或 task80 目录 | 不应投入/禁止 | 本任务不执行任何清理 |

## 7. Closed 事项与排除的重复任务

以下事项已有真实关闭证据，不应重复列为下一开发任务：

- 任务84真实低权 401/403 与临时账号清理：已验证；长期身份/Evidence 生命周期仍是
  C-01，不等于重做任务84。
- 任务86上线后 stable 收口：已完成；历史 wrapper 的零匹配退出码缺陷不构成生产事故。
- RISK-DP-002 物理备份与 BackupRecord 不同步：任务90已 Resolved / Closed。
- 每日真实 AES-256-GCM 文件级加密、checksum、认证解密和 gzip 校验：已完成。
- BackupRecord 自动同步、幂等重放和隔离 RestoreDrillRecord：已完成。
- 任务91 Release Gate Evidence 挂载、env/migration 刷新：已完成。
- 任务92 T+48 无人值守备份验收：已完成。
- 任务93 备份失败、容量、Evidence 不一致及 watchdog 自身失败告警：已完成。
- 任务94 active key 单文件误删/损坏恢复副本、完整性监控和真实演练：该子风险已关闭。
- 异机备份：不是 Closed，而是 Accepted；按明确决定从任务96排除。

## 8. 唯一推荐的任务96

### 推荐标题

**任务96：生产低权权限 Smoke 身份与 Evidence 生命周期长期化**

### 解决的问题

当前生产权限门禁本身有效，但 Evidence 固定 24 小时过期；任务92、93、94连续出现同一
required warning。现有刷新流程硬编码 task84 身份，必须人工输入 super_admin 凭据，
并短时执行密码重置、账号启用、登录、401/403、logout-all、账号禁用和 Evidence 写入。
这是一条已反复出现的长期运维/安全债，不是虚构的 P0。

### 为什么优先

1. 它已连续三次在真实生产 Gate 中复现，紧迫性高于尚未出现容量事故的数据保留债。
2. 它直接影响唯一标准 Release Gate 的持续可信性，但不要求移动 RC、修改 schema 或
   重做已关闭的备份工作。
3. 现有脚本已证明 401/403、最小角色、session cleanup 和 Evidence 格式，任务96可在
   已验证链路上做长期化，而不是从零设计。
4. 告警 SOP、审计不可变、依赖扫描等仍为 P1，但当前没有同样连续、可重复的 Gate warning。

### 明确包含

- 把 hard-coded task84/task91 命名抽象为稳定的 production permission-smoke 配置和入口；
  保留历史 Evidence 身份，不回写历史。
- 定义正式 smoke 账号/最小角色生命周期：默认 disabled、每次生成临时密码、短时启用、
  精确权限、logout-all、最终 disabled、active session=0。
- 定义 Evidence 24 小时 TTL、刷新 owner、执行频率、预到期提醒、失败升级和审计规则。
- 保留人工可见输入 super_admin 凭据的安全边界；任务96不得把 super_admin 密码长期化、
  写入环境文件、命令行、日志或 Evidence。
- 将预检、401、super_admin 权限链、低权 `/me`、Gate run 403、管理员接口 403、
  logout-all、禁用/清理、敏感扫描和最终 Gate 组织为单一、可重入、失败安全的流程。
- 补齐脚本单元/fixture 测试、API 权限回归、Runbook 和回滚说明。

### 明确排除

- 不配置异机备份、对象存储、DigitalOcean Spaces、S3 或异机 key 托管。
- 不修改 Prisma schema，不创建 migration，不改变角色/权限数据模型。
- 不新建长期 active 低权账号；优先复用并长期化既有受控 disabled 账号。
- 不自动保存或轮换 super_admin 凭据，不建立无人值守高权登录。
- 不降低 Evidence TTL、不复制旧时间戳、不用数据库计数替代真实 401/403。
- 不修改、移动或重签 `rc-20260712-2`。
- 不顺带处理告警 SOP、数据保留、审计 trigger、基础资料选择器或依赖升级。

### 执行条件

| 项目 | 结论 |
| --- | --- |
| 新执行窗口 | **需要**；任务96应先本地实现/测试，再申请独立生产安装与验收窗口 |
| 生产操作 | **需要**；安装脚本、执行一次真实 Smoke 和最终 Gate |
| Migration | **不需要** |
| 用户凭据 | **需要**；现有 super_admin 凭据只在用户可见 SSH 会话交互输入 |
| 人工审批 | **需要**；Security/Application/Operations/Release owner 批准账号和执行边界 |
| 影响现有 RC | 不移动 RC 标签；代码/运维脚本变更属于 RC 后版本，生产安装需单独审批 |

### 预计涉及文件或模块

- `deploy/scripts/production-permissions-smoke.sh`
- `deploy/scripts/production-permissions-smoke-helper.js`
- `deploy/scripts/production-release-gate.sh` 及其定向测试（仅在需要接入预到期状态时）
- `apps/api/src/release-gate/`、`apps/api/src/system-health/` 的只读 Evidence 状态检查
- `docs/operations/production-runbook.md`
- `docs/operations/production-handoff.md`
- 定向脚本 fixture、API 权限测试和 release gate 测试

### 最低测试范围

1. Bash/Node 语法和 helper fixture：正常、账号非 disabled、角色不唯一、权限过宽、
   super_admin 登录失败、任一步骤 HTTP 非预期、Evidence 写入失败。
2. 失败注入验证 cleanup trap：低权 session 撤销、账号最终 disabled、super session
   logout、`/run` 临时凭据清理。
3. API 权限回归：未认证 401；最小角色 `/me=200`；Gate run 和管理员接口 403；
   403 后 session 仍有效；logout-all 后失效。
4. Evidence 校验：production/fixture 标志正确、7/7、时间范围真实、无 token/password/
   hash/Authorization/Bearer、旧 Evidence 不被改写。
5. Release Gate：有效 Evidence 为 Pass；过期仍为 warning；不得降低 required 级别。
6. 全量 `pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm env:check` 和相关脚本测试。

### 上线风险与回滚边界

- 最高风险是中途失败后低权账号或 session 未清理，以及高权凭据泄露。
- 安装前保存 root-only 精确文件副本；只允许回滚本次脚本/helper/Runbook 安装。
- 不回滚 API/Web、数据库、权限模型、RC、备份链或历史 Evidence。
- 任何 cleanup 不能证明成功时，任务96必须停止并升级，不能运行 Gate 伪装成功。
- 回滚后仍保留旧的人工权限 Smoke 入口和真实过期 warning，不降低门禁。

### 可验证通过标准

1. 起始账号唯一、disabled、仅绑定唯一 `salary.view_self` 最小角色。
2. 未认证 `/me=401`。
3. super_admin 权限链和 Gate read 通过；凭据未落盘到长期路径或 Evidence。
4. 低权登录和 `/me=200`，权限恰为预期最小集合。
5. `POST /release-gate/run=403`，管理员读取接口 `403`，且 `/me` 仍 `200`。
6. logout-all 成功，账号最终 disabled，active low-priv=0，active sessions=0。
7. 新 Evidence 为真实 production、非 fixture、检查项完整、时间戳真实、敏感扫描零匹配。
8. 标准 Gate 在新 Evidence 有效期内恢复 `37/0/0`；旧文件和时间戳未改写。
9. API/Web restart 不增加，未部署业务代码、未 migration、未移动 RC。
10. 失败注入全部证明 fail-closed 和 cleanup；Runbook 明确 owner、频率、到期和升级路径。

## 9. 仍需产品经理/责任人决定

- A-01 是否优先改善 UUID 录入体验，以及第一批覆盖哪些表单。
- A-02 数据同步旧状态是否只改新记录语义，还是需要单独批准历史数据标注；本审计建议不
  批量改写历史。
- D-01 各类审计/告警/通知/session/备份记录的实际保留期和法律保全要求。
- C-02 采用数据库权限隔离还是拒绝 trigger；必须由 Data/Security owner 决策。
- B-01 值班 owner、响应 SLA 和外部通知渠道。
- C-01/任务96的执行频率与 owner；本规划不授权无人值守高权凭据。

## 10. 任务95边界确认

任务95及本次返修只创建/更新本规划文档。未修改业务/测试代码、Prisma schema、migration、
部署脚本或 systemd；未连接生产、未执行 sudo、未查询生产数据库、未部署/重启/切流、
未运行 production permissions smoke、未刷新 production Evidence、未修改 Git tag。
