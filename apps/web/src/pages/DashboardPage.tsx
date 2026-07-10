import { Alert, Button, DatePicker, Descriptions, Empty, List, Space, Spin, Statistic, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient, ApiError } from '../lib/api-client';
import type { Actor } from '../types/session';
import { canNavigateDashboardTarget, currentGmt8Month, formatDashboardMoney, formatDashboardTime } from './dashboard-utils';

type Todo = { code: string; severity: 'info' | 'warning' | 'error'; title: string; description: string; count: number; targetPath: string };
type Overview = {
  settlementMonth: string;
  refreshedAt: string;
  permissions: { sync: boolean; reconciliation: boolean; unmatched: boolean; settlement: boolean };
  sectionErrors?: Record<string, string>;
  monthStatus?: { isLocked: boolean; lockedAt: string | null; lockedBy: { id: string; displayName: string } | null; settlementStatus: string; generatedAt: string | null; finalizedAt: string | null; exportedAt: string | null };
  sync?: { taskCount: number; pendingCount: number; runningCount: number; completedCount: number; failedCount: number; cancelledCount: number; lastSuccessfulSyncAt: string | null; lastFailedSyncAt: string | null; byPlatform: Array<{ platform: string; taskCount: number; statuses: Record<string, number> }> };
  reconciliation?: Record<'affiliateRevenueUsd' | 'apiCardSpendUsd' | 'manualCardSpendUsd' | 'rawGrossProfitUsd' | 'matchedRevenueUsd' | 'unmatchedRevenueUsd' | 'matchedSpendUsd' | 'unmatchedSpendUsd', string>;
  unmatched?: { totalCount: number; affiliateIncomeCount: number; cardSpendCount: number; byReason: Record<string, number>; oldestUnresolvedAt: string | null; latestUnresolvedAt: string | null };
  employeesAndSettlement?: { activeEmployeeCount: number; employeesWithRevenueCount: number; employeesWithSpendCount: number; settlementDetailCount: number; totalSalaryRmb: string; settlementStatus: string };
  todos: Todo[];
};

const statusText: Record<string, string> = { not_generated: '未生成', draft: '草稿', confirmed: '已确认', locked: '已锁账', pending: '待执行', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消', not_implemented: '未接入' };
const severityColor = { info: 'blue', warning: 'orange', error: 'red' } as const;

export function DashboardPage({ actor, onNavigate }: { actor: Actor; onNavigate: (path: string) => void }) {
  const [month, setMonth] = useState(currentGmt8Month);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (selectedMonth: string) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const next = await apiClient.request<Overview>(`/dashboard/overview?settlementMonth=${encodeURIComponent(selectedMonth)}`);
      if (id === requestId.current) setData(next);
    } catch (loadError) {
      if (id === requestId.current) setError(loadError instanceof ApiError ? loadError.message : '运营总览加载失败。');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(month); }, [load, month]);
  const selectMonth = (_value: unknown, dateString: string | string[]) => setMonth(Array.isArray(dateString) ? dateString[0] : dateString);

  return (
    <section className="page-section dashboard-page">
      <div className="data-page-header">
        <div><Typography.Title level={3}>运营总览</Typography.Title><Typography.Text type="secondary">统一按 GMT+8 结算月份展示</Typography.Text></div>
        <Space><DatePicker picker="month" value={null} placeholder={month} format="YYYY-MM" allowClear={false} onChange={selectMonth} /><Button loading={loading} onClick={() => void load(month)}>刷新</Button></Space>
      </div>
      {error ? <Alert className="data-page-notice" type="error" showIcon message="刷新失败，已保留上次成功数据" description={error} /> : null}
      {data?.sectionErrors && Object.keys(data.sectionErrors).length ? <Alert className="data-page-notice" type="warning" showIcon message="部分区域加载失败" description={Object.keys(data.sectionErrors).join('、')} /> : null}
      {!data && loading ? <div className="dashboard-loading"><Spin /></div> : null}
      {data ? <>
        <Space className="dashboard-meta" wrap><Tag>{data.settlementMonth}</Tag><Typography.Text type="secondary">最后刷新：{formatDashboardTime(data.refreshedAt)}</Typography.Text></Space>
        {data.monthStatus ? <DashboardSection title="月份状态"><Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} items={[
          { key: 'status', label: '结算状态', children: statusText[data.monthStatus.settlementStatus] ?? data.monthStatus.settlementStatus },
          { key: 'lock', label: '锁账状态', children: <Tag color={data.monthStatus.isLocked ? 'red' : 'green'}>{data.monthStatus.isLocked ? '已锁账' : '未锁账'}</Tag> },
          { key: 'generated', label: '生成时间', children: formatDashboardTime(data.monthStatus.generatedAt) },
          { key: 'finalized', label: '确认时间', children: formatDashboardTime(data.monthStatus.finalizedAt) },
          { key: 'lockedAt', label: '锁账时间', children: formatDashboardTime(data.monthStatus.lockedAt) },
          { key: 'lockedBy', label: '锁账人', children: data.monthStatus.lockedBy?.displayName ?? '—' },
        ]} /></DashboardSection> : null}
        {data.sync ? <DashboardSection title="数据同步状态"><div className="dashboard-stats">{[
          ['任务', data.sync.taskCount], ['待执行', data.sync.pendingCount], ['运行中', data.sync.runningCount], ['已完成', data.sync.completedCount], ['失败', data.sync.failedCount], ['已取消', data.sync.cancelledCount],
        ].map(([title, value]) => <Statistic key={String(title)} title={title} value={value} />)}</div><Table size="small" pagination={false} rowKey="platform" dataSource={data.sync.byPlatform} columns={[
          { title: '平台 / Provider', dataIndex: 'platform' }, { title: '任务数', dataIndex: 'taskCount' }, { title: '待执行', render: (_, row) => (row.statuses.pending ?? 0) + (row.statuses.not_implemented ?? 0) }, { title: '运行中', render: (_, row) => row.statuses.running ?? 0 }, { title: '完成', render: (_, row) => row.statuses.completed ?? 0 }, { title: '失败', render: (_, row) => row.statuses.failed ?? 0 },
        ]} /></DashboardSection> : null}
        {data.reconciliation ? <DashboardSection title="收入与花费核对"><div className="dashboard-stats">{Object.entries({ 联盟收入: data.reconciliation.affiliateRevenueUsd, API卡花费: data.reconciliation.apiCardSpendUsd, 手工卡花费: data.reconciliation.manualCardSpendUsd, 原始毛利: data.reconciliation.rawGrossProfitUsd, 已匹配收入: data.reconciliation.matchedRevenueUsd, 未匹配收入: data.reconciliation.unmatchedRevenueUsd, 已匹配花费: data.reconciliation.matchedSpendUsd, 未匹配花费: data.reconciliation.unmatchedSpendUsd }).map(([title, value]) => <Statistic key={title} title={title} value={formatDashboardMoney(value)} />)}</div></DashboardSection> : null}
        {data.unmatched ? <DashboardSection title="未匹配事件"><div className="dashboard-stats"><Statistic title="未解决总数" value={data.unmatched.totalCount} /><Statistic title="联盟收入" value={data.unmatched.affiliateIncomeCount} /><Statistic title="卡花费" value={data.unmatched.cardSpendCount} /><Statistic title="最早未解决" value={formatDashboardTime(data.unmatched.oldestUnresolvedAt)} /></div>{Object.keys(data.unmatched.byReason).length ? <Space wrap>{Object.entries(data.unmatched.byReason).map(([reason, count]) => <Tag key={reason}>{reason}: {count}</Tag>)}</Space> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前月份没有未解决事件" />}</DashboardSection> : null}
        {data.employeesAndSettlement ? <DashboardSection title="员工与工资结算"><div className="dashboard-stats"><Statistic title="在职员工" value={data.employeesAndSettlement.activeEmployeeCount} /><Statistic title="有收入员工" value={data.employeesAndSettlement.employeesWithRevenueCount} /><Statistic title="有花费员工" value={data.employeesAndSettlement.employeesWithSpendCount} /><Statistic title="结算明细" value={data.employeesAndSettlement.settlementDetailCount} /><Statistic title="正式工资合计" value={formatDashboardMoney(data.employeesAndSettlement.totalSalaryRmb, 'RMB')} /></div></DashboardSection> : null}
        <DashboardSection title="管理员待办"><List locale={{ emptyText: '当前月份没有待办预警' }} dataSource={data.todos} renderItem={(item) => <List.Item actions={canNavigateDashboardTarget(actor, item.targetPath) ? [<Button key="go" type="link" onClick={() => onNavigate(item.targetPath)}>去处理</Button>] : []}><List.Item.Meta avatar={<Tag color={severityColor[item.severity]}>{item.severity}</Tag>} title={`${item.title}${item.count > 0 ? ` (${item.count})` : ''}`} description={item.description} /></List.Item>} /></DashboardSection>
      </> : !loading ? <Empty description="暂无总览数据" /> : null}
    </section>
  );
}

function DashboardSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="dashboard-section"><Typography.Title level={5}>{title}</Typography.Title>{children}</div>;
}
