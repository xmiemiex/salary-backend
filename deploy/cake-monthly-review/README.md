# CAKE 月度人工核对发布

用户已明确授权上线候选 `ea3b9f31e398a0aa4ea29413f3e42fedd731973a`。源码包 SHA256 `f1cd08271416929a0abdc08ef2875534beaae4cdccbd89b968d4d249319df466`，应用标签 `cake-review-ea3b9f31e398`。

`rollout.sh` 默认 plan 不执行；部署入口为 root 运行 `deploy-approved`，显式传入 `STAGE=/home/salaryops/cake-monthly-review-ea3b9f31e398` 和本地批准的 `APPROVED_CHECKS_SHA256`。使用保持打开的 PowerShell/SSH TTY 输入 sudo 和正式管理员密码。工具摘要、归档、安全路径、schema 与唯一新 migration SQL 均固定核验。

回退基线是已上线限流热修 `monthly-hotfix-4328cada3fe0`，API `sha256:a0b62028409b94c22cfdabfad3bc33ff2639030a7aebfd25aada2b8d96dfde0e`，Web `sha256:7361ddee07ca26020b8bbeb878dc494d97d5ca0b7c6fd3509891efe3658c6ca1`。启动或应用验收失败自动恢复这两张镜像，保留新增表和数据库内容，不做删表或数据库恢复。

旧 API 运行期间构建批准源码并创建新鲜加密备份，通过实际文件 SHA、认证解密/gzip 检查后才停写。生产27项迁移须逐项匹配，无活动任务，自动开关关闭；维护中仅应用 `20260907010000_cake_monthly_income_review`，升级到28项。原收入/调整/卡账目/手续费/映射/统一SUB/锁月/别名/排除/同步任务摘要保持，新增证据表空，不制造核对数据。

正式 API 验收只 GET：登录、匿名401、七八九月金额费率哈希、逐CAKE账号状态与既有调整页对应、七月PP完整覆盖。浏览器由主代理只读验证，无刷新、无确认/取消、无合成数据。两次登录之间注销旧预检会话，最终短期会话仅加密传回，浏览器完成后由主代理注销。

安全证据白名单自动导出到暂存目录 `public-evidence`，不导出明文登录凭据。脚本已通过 Bash/Node语法与真实本地随机schema的27项before/28项after门禁验证；业务写入行为沿用候选的隔离测试，不宣称生产写测试。
