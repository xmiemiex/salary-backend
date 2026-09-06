type Task = { status: string; successCount: number; failedCount: number; lastErrorCategory: string | null };

// Only enumerated reasons and aggregate counts leave the dashboard API. Provider
// payloads and unmatched transaction identifiers belong in the restricted detail UI.
export function monthlySourceStatus(task: Task | null, complete: boolean, coverageReason: string, unmatched: Record<string, number> = {}) {
  if (!task) return { status: 'missing', statusLabel: '未同步', reason: null };
  const active = ['pending', 'running', 'retry_wait'].includes(task.status);
  const status = active || task.status === 'cancelled' ? task.status
    : task.failedCount > 0 ? task.successCount > 0 ? 'partial' : 'failed'
    : task.status === 'completed' && !complete ? 'partial' : task.status;
  const labels: Record<string, string> = { pending: '等待刷新', running: '刷新中', retry_wait: '等待自动重试', completed: '已同步', partial: '部分成功', failed: '刷新失败', cancelled: '已取消' };
  const categoryReasons: Record<string, string> = {
    CREDENTIAL_MISSING: '尚未配置有效凭据', CREDENTIAL_INVALID: '来源凭据无效或无访问权限',
    TIMEOUT: '来源响应超时', NETWORK_ERROR: '来源网络连接失败', PROVIDER_5XX: '来源服务暂不可用',
    TEMPORARY_DATABASE_ERROR: '数据库暂时异常', MONTH_LOCKED: '该月份已锁账',
    INVALID_CONFIGURATION: '来源配置无效', VALIDATION_ERROR: '来源数据校验失败',
    PERMISSION_ERROR: '来源访问权限不足', BUSINESS_REJECTED: '来源拒绝请求，请查看同步详情',
    UNSUPPORTED_PLATFORM: '暂不支持该联盟平台', UNSUPPORTED_PROVIDER: '暂不支持该卡平台',
  };
  const details: string[] = [];
  if (task.lastErrorCategory === 'RATE_LIMITED') details.push(active
    ? task.status === 'retry_wait' ? '供应商限流，等待自动重试' : task.status === 'running' ? '上次请求被限流，正在重试' : '供应商限流，等待执行'
    : '供应商限流，本次任务已结束，需手动重试');
  else if (task.lastErrorCategory) {
    const reason = categoryReasons[task.lastErrorCategory] ?? '来源执行异常，请查看同步详情';
    details.push(reason + (task.status === 'retry_wait' ? '，等待自动重试' : task.status === 'running' ? '，正在重试' : ''));
  }
  if (unmatched.SUB_ID_NOT_MAPPED) details.push(`${unmatched.SUB_ID_NOT_MAPPED} 条 SUB 未映射`);
  if (unmatched.SUB_ID_MISSING) details.push(`${unmatched.SUB_ID_MISSING} 条缺少 SUB`);
  const other = Object.entries(unmatched).filter(([key]) => !['SUB_ID_NOT_MAPPED', 'SUB_ID_MISSING'].includes(key)).reduce((n, [, count]) => n + count, 0);
  if (other) details.push(`${other} 条其他归属异常，请查看未匹配事件`);
  if (task.failedCount > 0) details.push(`成功 ${task.successCount} 条 / 失败 ${task.failedCount} 条`);
  if (!details.length && status === 'partial') details.push(coverageReason);
  if (!details.length && status === 'failed') details.push('来源未完成，请查看同步详情');
  return { status, statusLabel: !active && task.status !== 'cancelled' && task.failedCount > 0 && task.successCount === 0 ? '未入账' : labels[status] ?? status, reason: details.join('；') || null };
}
