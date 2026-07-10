# 本地开发

## 工具链

- Node.js：`>=22.13`，当前基线已在 `24.17.0` 验证。
- pnpm：固定为 `10.32.1`，以根目录 `package.json` 的 `packageManager` 为准。

首次使用 Corepack 时，在 Windows PowerShell 中执行。若 Node 安装在受保护的 `C:\Program Files`，将 shim 安装到当前用户目录，避免要求管理员权限：

```powershell
New-Item -ItemType Directory -Path "$env:APPDATA\npm" -Force | Out-Null
corepack enable pnpm --install-directory "$env:APPDATA\npm"
corepack prepare pnpm@10.32.1 --activate
pnpm --version
pnpm install --frozen-lockfile
```

确认 `$env:APPDATA\npm` 已在用户 `PATH` 中；重新打开 PowerShell 后，`pnpm --version` 应输出 `10.32.1`。依赖构建许可仅在 `pnpm-workspace.yaml` 的 `allowBuilds` 中维护。

## 环境变量

从示例创建本地配置，并仅在本机填写实际值：

```powershell
Copy-Item .env.example .env
```

项目需要 `DATABASE_URL` 和 `API_CREDENTIAL_ENCRYPTION_KEY`。不要提交 `.env`，也不要把数据库密码、JWT、API Key 或加密密钥写入仓库。

## Prisma

### Monthly sync task planner

The in-process planner is disabled by default in every environment. Set
`SYNC_PLANNER_ENABLED=true` explicitly in production to enable it. The defaults
are day `10`, hour `9`, and timezone `Asia/Shanghai`; day accepts `1`-`28`, hour
accepts `0`-`23`, and no other timezone is accepted. After the configured GMT+8
time, it creates pending tasks for the previous month. It never executes a task
or calls an external API. Invalid values stop API startup without printing any
environment secrets.

Automatic execution is a separate opt-in. `SYNC_AUTO_EXECUTION_ENABLED` defaults
to `false` and production must explicitly set it to `true`. Defaults are a
60-second poll, batch size 2, 3 attempts, 900-second lease and 300-second retry
base. The lease must be longer than the poll interval.

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm prisma:migrate
pnpm prisma:seed
```

`prisma:migrate` 会执行开发迁移；运行迁移和 seed 前，确认 `.env` 中的 PostgreSQL 连接指向预期的本地开发数据库。

## 启动服务

分别在两个 PowerShell 窗口运行：

```powershell
pnpm --filter @salary/api start:dev
pnpm --filter @salary/web dev
```

## 质量检查

```powershell
pnpm typecheck
pnpm test
pnpm build
```

## 管理员登录与会话

API 使用 `AUTH_SESSION_TTL_HOURS` 控制不透明会话 Token 的有效期，默认 12 小时，允许范围为 1 到 168。`WEB_ORIGIN` 必须是明确的 HTTP(S) origin，例如 `http://localhost:5173`；CORS 不允许通配 origin，也不启用 cookie credentials。

先执行 `pnpm prisma:seed` 创建角色和权限，再通过环境变量创建管理员。密码不会输出，也不要把真实密码写入 `.env` 或提交仓库：

```powershell
$env:ADMIN_USERNAME='admin'
$env:ADMIN_EMAIL='admin@example.com'
$env:ADMIN_PASSWORD=(Read-Host 'Password')
$env:ADMIN_ROLE='super_admin'
pnpm admin:create
Remove-Item Env:ADMIN_PASSWORD
```

用户名重复时命令拒绝执行。如需显式更新已有同名账号，设置 `$env:ADMIN_UPDATE='true'`。seed 只创建角色和权限，不创建默认管理员。

`POST /auth/login` 的防爆破限制为单个 API 进程内、每 IP 每分钟最多 5 次尝试。该内存限流不提供多实例全局限制；多实例部署应在网关或共享存储限流层实施统一策略。
