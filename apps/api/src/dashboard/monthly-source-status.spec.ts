import { monthlySourceStatus } from './monthly-source-status';
import { MonthlyFinanceService } from './monthly-finance.service';

const task = { status: 'completed', successCount: 0, failedCount: 1, lastErrorCategory: null };
const summarize = (change = {}, reasons = {}) => monthlySourceStatus({ ...task, ...change }, false, '缺少完整正式入账证据', reasons);

describe('monthly source failure summaries', () => {
  it('reports zero posted income and missing mapping rather than generic partial success', () => {
    expect(summarize({}, { SUB_ID_NOT_MAPPED: 1 })).toEqual({ status: 'failed', statusLabel: '未入账', reason: '1 条 SUB 未映射；成功 0 条 / 失败 1 条' });
  });
  it('reports mixed posting and missing SUB separately from unified display SUB', () => {
    expect(summarize({ successCount: 4 }, { SUB_ID_MISSING: 1 })).toEqual({ status: 'partial', statusLabel: '部分成功', reason: '1 条缺少 SUB；成功 4 条 / 失败 1 条' });
  });
  it.each([
    ['retry_wait', '等待自动重试'], ['running', '正在重试'], ['pending', '等待执行'], ['failed', '本次任务已结束，需手动重试'],
  ])('retains actual %s state after rate limiting and partial posting', (status, text) => {
    const value = summarize({ status, successCount: 1109, lastErrorCategory: 'RATE_LIMITED' });
    expect(value.status).toBe(status === 'failed' ? 'partial' : status);
    expect(value.reason).toContain(text);
    expect(value.reason).toContain('成功 1109 条 / 失败 1 条');
    if (status === 'failed') expect(value.reason).not.toContain('自动重试');
  });
  it.each([
    ['CREDENTIAL_MISSING', '尚未配置有效凭据'], ['CREDENTIAL_INVALID', '凭据无效'], ['TIMEOUT', '响应超时'],
    ['BUSINESS_REJECTED', '来源拒绝请求'], ['MONTH_LOCKED', '已锁账'], ['NETWORK_ERROR', '网络连接失败'],
  ])('keeps specific %s failures without raw provider errors', (category, text) => {
    expect(summarize({ status: 'failed', lastErrorCategory: category }).reason).toContain(text);
  });
  it('does not claim coverage from an empty successful legacy task', () => {
    expect(summarize({ failedCount: 0 })).toMatchObject({ status: 'partial', reason: '缺少完整正式入账证据' });
    expect(monthlySourceStatus({ ...task, failedCount: 0 }, true, 'unused')).toMatchObject({ status: 'completed', reason: null });
  });
  it('reads current-task reason counts without exposing identifiers or replacing prior coverage', async () => {
    const latest = { ...task, id: 'current-task', requestPayload: { settlementMonth: '2026-07' }, resultPayload: {}, finishedAt: new Date('2026-09-06') };
    const previous = { status: 'completed', failedCount: 0, requestPayload: { settlementMonth: '2026-07' }, resultPayload: { monthlyCoverage: { version: 1, month: '2026-07', from: '2026-06-30T16:00:00.000Z', through: '2026-07-31T16:00:00.000Z', posted: true, scope: 'all_accounts_cards' } }, finishedAt: new Date('2026-08-02') };
    const db = {
      affiliateAccount: { findMany: jest.fn().mockResolvedValue([{ id: 'account', accountName: 'Influx' }]) },
      monthlyRefreshBatch: { findFirst: jest.fn().mockResolvedValue(null) },
      syncTask: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn().mockImplementation(({ where }) => Promise.resolve(where.affiliateAccountId ? where.status ? previous : latest : null)) },
      syncUnmatchedEvent: { groupBy: jest.fn().mockResolvedValue([{ reasonCode: 'SUB_ID_NOT_MAPPED', _count: 1 }]) },
    };
    const result = await new MonthlyFinanceService(db as never, {} as never).status('2026-07', new Date('2026-09-06'));
    expect(db.syncUnmatchedEvent.groupBy).toHaveBeenCalledWith({ by: ['reasonCode'], where: { syncTaskId: 'current-task', settlementMonth: new Date('2026-07-01') }, _count: true });
    expect(result.sources[0]).toMatchObject({ status: 'failed', statusLabel: '未入账', unmatchedCount: 1, lastSuccessAt: previous.finishedAt, coverageComplete: true });
    expect(JSON.stringify(result)).not.toContain('current-task');
  });
});
