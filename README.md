# 工资结算后台：本地开发启动指南

本文面向 Windows PowerShell。数据库由 Docker Compose 管理；API、Web、Prisma 命令由仓库锁定的 pnpm 工具链运行。

## 前置条件

- Node.js 与 Corepack/pnpm（版本以根目录 `package.json` 的 `packageManager` 为准）
- Docker Desktop，且 `docker compose version` 可执行
- PowerShell 5.1 或更高版本

## 环境变量

先创建本地配置：

```powershell
Copy-Item .env.example .env
```

必须将 `API_CREDENTIAL_ENCRYPTION_KEY` 的占位符替换为随机 32 字节密钥。以下命令只把新密钥写入当前 PowerShell 变量；请手动将输出填入本地 `.env`，不要提交 `.env`：

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

主要变量：

| 变量 | 用途 | 本地示例/规则 |
| --- | --- | --- |
| `DATABASE_URL` | Prisma PostgreSQL 连接串 | 应与下方 Compose 参数及 `POSTGRES_PORT` 一致 |
| `POSTGRES_PORT` | 主机数据库端口 | 默认 `5432`，端口冲突时可修改 |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | 仅本地 Compose 数据库初始化 | 模板值只适用于本地开发 |
| `API_PORT` | API 监听端口 | 默认 `3000` |
| `WEB_PORT` | Vite 监听端口 | 默认 `5173` |
| `VITE_API_BASE_URL` | 浏览器调用的 API 地址 | 端口应与 `API_PORT` 一致 |
| `CORS_ALLOWED_ORIGIN` | 唯一允许的 Web Origin | 必须是无路径、无结尾斜杠的绝对 HTTP(S) Origin |
| `ADMIN_SESSION_TTL_SECONDS` | 管理员会话寿命 | `60` 至 `604800` 秒，默认模板为 12 小时 |
| `API_CREDENTIAL_ENCRYPTION_KEY` | 第三方 API 凭证 AES-256-GCM 密钥 | 必填；32 字节原文或 base64 编码的 32 字节随机值 |

API 启动时会校验加密密钥。空值、明显占位符、错误长度在任何环境都会失败；生产环境不会获得默认密钥。旧变量 `PORT`、`WEB_ORIGIN`、`AUTH_SESSION_TTL_HOURS` 暂时兼容，新变量优先。测试直接构造服务，不依赖隐式生产密钥。

## 首次启动

在项目根目录 `D:\Xcode\后台` 依次执行：

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
# 编辑 .env，并至少替换 API_CREDENTIAL_ENCRYPTION_KEY 占位符
pnpm db:up
pnpm db:wait
pnpm db:migrate
pnpm db:seed
```

创建首个管理员前，使用交互式安全输入把密码短暂放进当前进程环境，不把密码写进命令行历史：

```powershell
$securePassword = Read-Host '管理员密码' -AsSecureString
$passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $env:ADMIN_USERNAME = 'admin'
  $env:ADMIN_EMAIL = 'admin@example.local'
  $env:ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
  pnpm admin:create
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
  Remove-Item Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
  $securePassword.Dispose()
}
```

`seed` 只创建/更新角色和权限，不创建管理员。项目不会生成默认管理员或默认密码。管理员密码必须由操作者通过 CLI 环境变量传入；CLI 不会输出密码。不要将密码写入命令文本、日志、`.env` 或 Git。

完成迁移后启动开发服务：

```powershell
pnpm dev
```

`pnpm dev` 会读取根目录 `.env`、等待 PostgreSQL 健康、执行 `prisma migrate deploy`，只有迁移成功才并行启动 API 与 Web。数据库未就绪或迁移失败会明确报错并停止。它不会执行 seed、创建管理员、清空数据库或硬编码密码。

打开 `http://localhost:5173`，用刚创建的管理员登录。另开 PowerShell 验证健康状态：

```powershell
Invoke-RestMethod http://localhost:3000/health/live
Invoke-RestMethod http://localhost:3000/health/ready
```

如果修改了端口，请同步修改 `.env` 中 `VITE_API_BASE_URL`、`CORS_ALLOWED_ORIGIN`，并在检查 URL 中使用新的 `API_PORT`。

## 数据库与停止服务

按 `Ctrl+C` 停止 API/Web。停止 PostgreSQL 容器但保留 named volume 中的数据：

```powershell
pnpm db:down
```

之后执行 `pnpm db:up` 会复用原数据。查看状态可执行 `pnpm db:status`。

仅在明确需要彻底重置本地开发数据库时执行以下破坏性命令。它会永久删除 Compose named volume 及其中全部数据，无法恢复：

```powershell
docker compose down --volumes
pnpm db:up
pnpm db:wait
pnpm db:migrate
pnpm db:seed
```

常规脚本不会删除 volume，也不会自动重置数据库。

## 健康检查语义

- `GET /health/live`：无需登录，不访问数据库；API 进程可处理 HTTP 时返回 `200 {"status":"ok"}`。
- `GET /health/ready`：无需登录，执行固定的 `SELECT 1`；数据库可用时返回 `200 {"status":"ready"}`，不可用时返回 `503 {"status":"not_ready"}`。

两个接口均不写业务审计日志。就绪检查不会返回连接串、密码、Token、异常消息或内部堆栈。

## 常用命令

```text
pnpm db:up       启动 PostgreSQL
pnpm db:down     停止 Compose 服务，保留数据 volume
pnpm db:status   查看 PostgreSQL 容器与健康状态
pnpm db:wait     等待数据库变为 healthy（默认最多 90 秒）
pnpm db:migrate  执行 prisma migrate deploy
pnpm db:seed     写入角色和权限基础数据
pnpm admin:create 使用现有 CLI 创建或按参数更新管理员
pnpm dev         校验数据库/迁移后启动 API 和 Web
```
