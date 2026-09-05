# 月度收支真实 API 联调与发布准备

原验收候选：6853c629785c0227dc49359dc48199edfd239726。真实 PP 整月联调暴露 10 分钟预算下从头重试的问题，本轮新增独立分页进度表、完整页检查点、查询截止时间冻结及带尝试次数的租约写保护；最终候选与构建哈希以新 manifest 为准。生产只读、供应商只读、本地隔离写入，未部署生产。

## CAKE 已确认口径

2026-09-06 用户明确：联盟整体时区通过 API 无法修改，返回原生时区的当月 SUB 佣金，GMT+8 月界偏差由后台手动加减修正。验收公式为原生佣金 + 已确认人工调整。原生时区不是 GMT+8 不再是阻塞项，不能把原生 API 月报宣称为已按 GMT+8 重算。

已用隔离 HTTP 调整接口创建并确认 +12.34 USD / -5.67 USD，随后再次刷新真实 CAKE 月报，两条记录哈希完全一致，大盘收入正确包含净调整 +6.67 USD。这两笔是合成测试值，不是生产调整。

## 实际环境与来源

独立库为 localhost:35439/monthly_finance_live_c19642d1e6f0，API 3061、Web 5191，两个调度开关 false。原复核环境 5189 未改写。导入 4 个有效联盟账号、AW/PP、7 名员工、4494 张卡、1 条别名、1 条排除规则。生产只读事务导出的配置经公钥封装，内存解密后以独立本地密钥重新加密；不复制完整生产 .env、数据库或原密钥。

PP 唯一有效凭据 ID、原始与导入 payload、生产 base URL 和标准认证路径均一致。本地直连 PP 返回业务 403/forbidden，A01 返回持续 429；同一凭据经现有服务器出口均成功，不能断言密钥失效。本地 TLS 转发只允许认证和报表读取路径，不修改生产配置。

| 来源 | 2026-08 已验证结果 | 限制 |
| --- | --- | --- |
| A01 | 原生 API 双汇总 60 USD，真实 HTTP 重试入账完成 | 无独立 Portal 月报 |
| A02 | 双汇总均 0 USD，整月转换明细声明总数 0、实际 0、1 页结束，HTTP 完成 | API 内部核查不等于独立对账 |
| A03 | 原生月报 52704 USD、4 条入账，再次刷新完成 | 另加人工调整 |
| A04 | 原生月报 106730 USD、4 条入账，再次刷新完成 | 另加人工调整 |
| AW | 初次整月 20 条、1097.62 USD，全量 checkpoint 落库，后续刷新完成 | 本轮初次扫描一次成功，不能声称真实测试了初次中断续跑 |
| PP | 单日 179 条/2 页；修复后整月 5340 条、36096.62 USD，0 笔归属失败、0 笔金额冲突；完整重刷完成且账目集合哈希一致 | 2616 笔原币非 USD，成本使用供应商实际 USD 本金 |

真实 HTTP 一次创建 6 个任务；紧接重复请求 reused=true 且同 batch。开关 false 时手动 worker 正常执行；失败来源不阻塞其他来源。真实网络中断按 300/600 秒退避，3 次终止，允许手动新批次。最新整月和重复刷新结果见 http-latest-evidence.json。

## 其他验证

- 7 名员工预设 businessSubId 均为空。保留可唯一推导的映射和待统一状态，不替用户猜业务 ID。仅合成测试员工设 LIVE-VALIDATION-001，确认单行聚合、卡成本等于员工账目。
- 合成 Adpos 100 USD、费率 3%/3%/3.5%，刷新后记录哈希不变。原 2026-08 人工收入和成本导入数量均为 0。
- 单独 2026-06 合成锁账测试，refresh/fees/adpos/sub-id 均 409、未创建任务；测试后清除合成锁账。
- Edge + 5191 Web + 实际 3061 API：核心五列可见、6 个员工行、真实 PP 明细页 20 条，无页面错误。
- 既有 PostgreSQL/模拟供应商测试只作为模拟证据，不冒充真实 API 验证。

## 生产只读核验与发布步骤（不执行）

API 回退镜像 salary-settlement-api:task102-f859d79c2b8f，ID sha256:6f940a27f83b5d9e1ee40c726c2accfdb2a0350bf2bd6bb7c57e4ce1253a63bf。

Web 回退镜像 salary-settlement-web:task102-f859d79c2b8f，ID sha256:7a13601d4578ab54a082372955cb25dcbc9d86ab264d96f7022dd6e1af52083c。

2026-09-05 14:36 UTC 所读最新备份记录：当日 02:22 UTC 成功，加密、544177 bytes，SHA256 ecd1b7f7c96a709b08c92b4fb9d8f4c69bb3f2dea568bf033ea914f9421ff2bc；最近恢复演练记录为 2026-07-27 成功。仅核验记录，未重新下载校验文件或执行恢复演练。

生产已安装迁移实际比对后待执行为以下 8 个（前 7 个已与生产实际比对，第 8 个为本轮新增）：

1. 20260905010000_monthly_finance_refresh
2. 20260905011000_inventory_checkpoint
3. 20260905012000_monthly_write_lock
4. 20260905013000_adpos_monthly_fee_consistency
5. 20260905014000_preserve_unambiguous_adpos_rates
6. 20260905015000_guard_inflight_financial_writes
7. 20260905016000_resumable_inventory
8. 20260906010000_transaction_page_resume

正式部署另需授权。沿用现有主机 PostgreSQL、Docker 网络、Nginx/Cloudflare/TLS/Tailscale；不加入本地转发设置。Web 使用原正式 HTTPS API origin，保留服务器密钥、连接串、PP webhook 和两个 false 开关。先核对新鲜备份，再通过一次性容器挂载候选 prisma 执行 migrate deploy，并切换 API/Web 镜像。应用回退恢复上述旧镜像，保留新增表、人工数据和审计，不默认整库恢复。

正式域名验收：登录、月份、统一 SUB、全来源刷新、截止时间、重试、Adpos/费率/CAKE 调整保留、锁账及工资口径。本轮不操作正式域名写入口。

## 剩余与证据

本地实现、真实整月联调和完整重刷已完成：6/6 来源成功，全部来源账目集合哈希不变。A01 重刷曾遇 429，第 3 次按既定退避成功，原收入全程保留。PP 实际进程中断后，新任务从保存的第 5 个查询段、第 18 页恢复（不是从第一页），最终清除进度并产生完整月覆盖证明。独立 Portal/原始月报未取得，不能宣称独立财务对账通过；未部署生产。CAKE 时区本身不再列为阻塞。

证据在忽略目录 tmp/monthly-finance-live：environment/import/configuration-integrity、按来源 probe、http-refresh/http-latest、behavior、cake-adjustment、browser、operational 等 JSON。私钥、加密封包、login、.env、映射和 private 夹具不能提交。可分享记录只保留来源别名、范围、金额、计数、时间、状态和哈希。原生收入与合成调整分开，旧 Task102/103 或同 API 重算不充当独立对账。


最终验证：API 标准回归 522 通过（数据库用例由独立命令显式开启）；专项数据库及覆盖测试 22 通过，见 final-database-tests.log；API/Web 构建通过。所有改动文件已对照真实凭据检查，未发现明文凭据。原始预算为 10 分钟，修复保留该上界及 3 次有限重试；新增分页状态不进入轻量状态轮询响应。

验证结束后已移除隔离库的合成 Adpos、两笔 CAKE 调整及测试费率，并恢复测试员工原 businessSubId；真实供应商账目保留。实际 2026-08 导入配置未包含月费率，因此真实 ROI 应待用户填写真实费率后计算，不沿用合成测试费率。清理前逐项核对记录哈希及原始空费率证据，见 fixture-cleanup-evidence.json。
