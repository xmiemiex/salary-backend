# 统一错误码

错误码定义在 `packages/shared/src/errors.ts`，API 通过 `AppError` 转换为 HTTP 响应。

| 错误码 | 建议 HTTP 状态 | 含义 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 参数或 DTO 校验失败 |
| `UNAUTHORIZED` | 401 | 未登录或 token 无效 |
| `FORBIDDEN` | 403 | 已登录但禁止访问 |
| `PERMISSION_DENIED` | 403 | 缺少具体权限点 |
| `MONTH_LOCKED` | 409 | 月份已锁账，禁止修改 |
| `DUPLICATE_RESOURCE` | 409 | 违反唯一约束或重复创建 |
| `CONFLICT` | 409 | 通用状态冲突 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `SETTLEMENT_NOT_FOUND` | 404 | 结算单不存在 |
| `SETTLEMENT_ALREADY_LOCKED` | 409 | 结算单已锁定 |
| `SETTLEMENT_PRECHECK_FAILED` | 400 | 生成或锁定前置检查失败 |
| `IMPORT_TEMPLATE_INVALID` | 400 | 导入模板错误 |
| `IMPORT_ROW_INVALID` | 400 | 导入行错误 |
| `AUDIT_WRITE_FAILED` | 500 | 审计写入失败 |
