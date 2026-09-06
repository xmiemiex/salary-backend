# 七月 PhotonPay 限流热修发布工具

仅部署已审核业务提交 `4328cada3fe053159d08be7394625ef462117903`，生产镜像标签为 `monthly-hotfix-4328cada3fe0`。此工具没有执行过生产写操作。

固定校验：

- 源码包 `source-4328cada3fe0.tar.gz`：`87ea2798ed279dbe39db4b086f2052aceb54faf482563c2d65025bc912637077`
- 原版本 schema SHA256：`70c90c44ffa9b31612acfd94cb249848ae90f2b1b67aa97aa0f42dfc177118a4`
- 原 API 镜像 `monthly-ea2b7f6a162f`：`sha256:8de5423b041f59f55ffbed072bb1712d2f5e13c218993f17528fd8bd18b98a81`
- 原 Web 同标签：`sha256:b52b44407ba9d16d5cab6e4ef82dbedf6a53fec9271a1bad450b395733f98daf`

## 执行入口

将本目录工具、审核后的 `checks.sha256` 和固定源码包放到 `/home/salaryops/monthly-finance-hotfix-4328cada3fe0`。工具清单本身的 SHA256 由本地发布准备证据提供，不能在服务器上临时生成后当作已审核值。

```bash
bash rollout.sh plan
sudo env STAGE=/home/salaryops/monthly-finance-hotfix-4328cada3fe0 \
  APPROVED_CHECKS_SHA256='<本地已审核工具清单SHA256>' \
  bash /home/salaryops/monthly-finance-hotfix-4328cada3fe0/rollout.sh deploy-approved
```

使用用户已授权的可见 PowerShell / SSH TTY 输入 sudo 密码。脚本随后在同一终端请求正式管理员账号和隐藏密码；也可提供 root 所有、权限 600 的既有 `LOGIN_FILE`。密码和短期 token 只在 root 私有证据目录暂存，结束或错误处理后清除。不要将凭据写入命令行或发到对话中。

## 自动门禁与影响

1. 校验已审核工具清单、源码包、归档路径和 schema；新目录解包，构建前后 `tar --compare` 确认源码与批准包一致。拒绝复用已存在的候选目录或证据目录。
2. 核对现有运行镜像及可回退镜像精确 ID、自动开关关闭，生产现有 27 项迁移与候选 SQL 校验和逐项相符。**没有迁移执行命令**，未审核的 CAKE schema 不允许混入。
3. 活动同步必须为 0；校验正式登录；旧 API 运行时构建镜像、创建全新备份。备份检查必须同时通过实际校验和、认证解密和 gzip 完整性，文件 mtime 不能早于本次备份开始。
4. 再查活动任务，停止 API/Web 写入；比较停止前后的人工收入、全部收入、手工成本、两类月费率、SUB 映射、员工统一 SUB 和全部结算锁状态的摘要。任一变化停止自动流程，避免与并发财务修改交错。正常停站只覆盖镜像切换和健康检查。
5. 新 API/Web 启动后核验精确镜像、正式 HTTPS 健康、真实登录、匿名 401、七月/八月查询。严重启动或基础权限门禁失败自动恢复精确旧镜像，不动 schema 或数据库。
6. 七月仅对 PhotonPay：已完整则跳过；有活动批次则观察；锁月则跳过并报告；其余最多创建一次单源刷新。每 15 秒只读查询，最多等待 60 分钟，不更改供应商退避、超时或重试预算。限流持续或其他业务失败只报告真实状态，不错误触发回退或伪称完成。
7. 保存首次恢复页/窗口、有限重试状态、最后覆盖证据，比较原有七月账目逐行摘要及重复外部交易号计数。Influx/Blitzads 不刷新、不猜填 SUB、不处理未匹配事件、不人工调账。

## 证据与回退

证据目录：`/opt/salary-settlement-admin/release-evidence/monthly-hotfix-4328cada3fe0`，root 私有。脚本把安全白名单自动导出到 staging 下 `public-evidence`（失败时也导出），salaryops 可直接 scp 读取，不需第二次 sudo。可安全复核 `status.txt`、`archive-check.txt`、`schema-check.txt`、`new-images.txt`、`fresh-backup-health.txt`、`fresh-backup-sha256.txt`、`after-start.json`、`acceptance.json`、`ledger-proof.json`、`after-acceptance.json`。不得复制 `*.private*`；账目文件仅包含不可逆摘要。`acceptance.json` 每 15 秒记录界面状态及原因时间线，真实任务代次/下次尝试时间以最终 `after-acceptance.json` 为准，不将界面未返回的字段当作数据库事实。

`browser-public.pem` 是已批准本地接收公钥，纳入工具清单。上线后的真实登录 token 通过随机 AES-256-GCM 与 RSA 加密导出为 `browser-session.encrypted.json`，仅拥有本地接收私钥的主代理可解密用于页面验收，验收后须调用正式注销接口。部署预检 session 会在第二次登录前主动注销；正式验收 session 在删除服务器明文 token 后仍有效，以便主代理完成浏览器检查并注销。

供应商验收启动后若检查异常，脚本保留新版和任务现场，输出 `NEW_VERSION_RUNNING_REVIEW_ACCEPTANCE_ERROR_NO_BLIND_TASK_INTERRUPTION`；由负责发布的代理根据具体证据判断是否业务故障或真正应用回归。需要应用回退时：

```bash
sudo bash /home/salaryops/monthly-finance-hotfix-4328cada3fe0/rollback.sh rollback-approved
```

回退记录活动任务数，恢复上述两张精确旧镜像，保留 27 项 schema、已入账数据及断点；不会向下迁移或整库恢复。之后必须复核正式登录及可能被中断任务的状态。限流本身不是回退理由。

## 仍由负责发布的代理完成

本工具尚未做生产执行，实际sudo/登录权限、备份服务、生产基线必须现场确认。正式页面视觉验收和受限角色权限对比由代理另行完成；脚本覆盖真实管理员请求和匿名拒绝，不将其宣称为全部角色审计。若观察窗口结束时仍在供应商退避，继续按实际任务状态交付，不能宣称七月全量已完成。
