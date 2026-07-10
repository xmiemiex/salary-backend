# 项目初始化与技术底座方案

## 推荐目录结构

```text
apps/
  web/                         # React + TypeScript + Vite + Ant Design
  api/                         # Node.js + NestJS + TypeScript
packages/
  shared/                      # 前后端共享错误码、权限码、类型
prisma/
  schema.prisma                # PostgreSQL 数据模型
  seed.ts                      # RBAC 初始权限和角色
  migrations/                  # Prisma migration 输出目录
docs/
  business-rules/              # 业务规则沉淀
  api/                         # API 设计
  import-templates/            # 导入模板说明
  test-cases/                  # 验收和回归用例
```

## 初始化命令

```powershell
npm install
Copy-Item .env.example .env
npm run prisma:generate
npm run prisma:migrate -- --name init_core_schema
npm run prisma:seed
npm run typecheck
npm test
```

`DATABASE_URL` 必须指向 PostgreSQL。当前仓库只提供底座代码，不包含 Docker Compose；如需本地数据库，可后续补 `docker-compose.yml`。

## 当前阶段边界

本阶段只完成项目结构、数据库结构、RBAC、审计、锁账底座和错误码。明确不实现：

- 工资计算引擎。
- API 同步收入逻辑。
- Airwallex / PhotonPay 同步逻辑。
- 复杂前端页面。
- 结算生成、重算、导出业务流程。

## 后续任务要接上的接口

- `POST /auth/login`
- `GET /me`
- `GET /permissions`
- `POST /employees`
- `POST /sub-id-mappings`
- `POST /card-bindings`
- `POST /income-records/import`
- `POST /manual-card-spend-entries`
- `POST /monthly-card-provider-fee-rates`
- `POST /monthly-exchange-rates`
- `POST /historical-negative-profits`
- `POST /monthly-performance-groups`
- `POST /monthly-salary-manual-items`
- `POST /settlements/:month/generate`
- `POST /settlements/:month/recalculate`
- `POST /settlements/:month/lock`
- `POST /settlements/:month/unlock`，第一版默认不开放；如保留，必须 `super_admin` 且强制审计。
- `GET /audit-logs`
- `GET /salary/self`
- `GET /salary`
- `POST /salary/export`
