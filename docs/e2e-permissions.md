# 权限回归 E2E

## 运行方式

在 Windows PowerShell 中运行：

```powershell
pnpm e2e:permissions
```

该命令会：

1. 读取 `.env`，并把 `SYNC_PLANNER_ENABLED`、`SYNC_AUTO_EXECUTION_ENABLED` 固定为 `false`。
2. 等待 Docker PostgreSQL 可用并执行 `prisma migrate deploy`。
3. 启动真实 Nest API 和真实 Vite Web。
4. 使用 Playwright 打开真实浏览器，登录低权限用户并执行权限回归。
5. 按唯一前缀清理本轮创建的管理员、角色、会话、任务、凭证、审计、锁账月份和临时进程。

服务日志写入 `tmp/e2e-permissions-*`。日志只用于排障，不会打印 token、密码、hash 或密钥。

## 环境变量

必需：

- `DATABASE_URL`
- `API_CREDENTIAL_ENCRYPTION_KEY`

常用可选项：

- `E2E_API_PORT`，默认 `3100`
- `E2E_WEB_PORT`，默认 `5174`
- `E2E_BROWSER_CHANNEL`，默认 `msedge`；如果本机没有 Edge，会回退到 Playwright Chromium

## PostgreSQL

该 E2E 使用真实 PostgreSQL。默认使用项目 `compose.yaml` 中的 Docker PostgreSQL：

```powershell
pnpm db:up
pnpm db:wait
```

如果已有外部 PostgreSQL，也可以通过 `.env` 的 `DATABASE_URL` 指向该实例。测试数据全部带 `e2e_perm_*` 唯一前缀，并按 ID/前缀清理。

## 第三方 API 隔离

该 E2E 不请求 Everflow、CAKE、Airwallex、PhotonPay 真实 API：

- 自动执行 worker 在脚本中固定关闭。
- 测试只创建本地受控任务和本地受控 affiliate credential。
- 任务59同 session 用例调用的是 `request-retry` 权限边界，低权限用户在权限检查阶段返回 403，不进入 provider adapter。
- 页面文案和 E2E 断言会验证“请求重试只恢复 pending，不会在页面上立即调用外部 API”的运行台语义。

## 覆盖范围

覆盖任务 53-59 的统一权限边界：

- 管理员管理：无 `admin_users.read` 不能读取；有 read 无 manage 不能创建；403 后 `/me=200`。
- 角色权限：无 `role.read` 不能读取；有 read 无 manage 不能创建/保存；403 后 session 保留。
- 个人安全中心：登录用户可读取自己的安全资料和会话；撤销其他用户有效 session 返回 403；当前 session 保留。
- 仪表盘：低权限只看到允许的 dashboard section，不能通过 dashboard 绕过同步/结算权限。
- 同步规划：income-only 用户可 preview；无 `manual_card_spend.manage` 不能 generate；preview 不写任务、不写审计。
- 自动执行与同步任务：manual pending 任务不会被自动 worker 领取；income-only 用户不能执行 card_spend。
- 运行台与异常处置：income-only 用户可看运行台，但 card_spend retry/cancel 按钮 disabled；直接 API 返回 403；锁账月份 retry 返回 409。

## 任务59遗留验收点

E2E 使用真实浏览器登录 income-only 用户，在同一个页面上下文中读取 `sessionStorage` 的认证态，并用 `window.fetch` 调用真实 API：

```text
POST /sync-tasks/:taskId/request-retry
```

断言：

- 返回 403。
- 同 browser context 下 `/me` 返回 200。
- 刷新后仍停留在应用内，不跳登录页。
- 当前用户仍是低权限用户。
- 页面 retry/cancel 按钮初始 disabled。

该路径不依赖 DOM 篡改，也不增加生产后门。

## 401/403 排障

- 401 失败：检查 token 是否缺失、过期、伪造，或 `.env` 指向了错误数据库。
- 前端 401 未跳登录：检查 `ApiClient.onUnauthorized` 和 `sessionStorage` 清理。
- 403 后跳登录：检查是否把 `PERMISSION_DENIED` 误复用了 401 清理逻辑。
- 低权限按钮未禁用：检查页面 `actor.permissions` 与后端任务 `sourceType` 的权限映射。
- API 非 403：检查 controller guard 和 service 内二次权限检查是否一致。

## 敏感字段策略

E2E 扫描运行时页面文本、关键 API JSON 和本轮 actor 产生的 audit log。默认禁止出现：

`password`、`passwordHash`、`token`、`tokenHash`、`apiKey`、`secret`、`clientSecret`、`merchantId`、`encryptedPayload`、`DATABASE_URL`、`Authorization`、`Bearer`、`leaseOwner`。

业务安全字段默认不返回；确需返回时必须返回脱敏摘要，并且不得包含真实值。

## 清理策略

测试在 `finally` 中按精确 ID 删除：

- `AdminSession`
- `AuditLog`
- `SyncTask`
- `AffiliateAccountCredential`
- `AffiliateAccount`
- `AdminUserRole`
- `RolePermission`
- `AdminUser`
- `Role`
- `Employee`
- 测试创建的锁账 `MonthlySettlement`

清理后会再次查询本轮前缀和 ID，残留不为 0 时命令失败。
