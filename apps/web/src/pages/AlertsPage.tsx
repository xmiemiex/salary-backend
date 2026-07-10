import { Alert, Button, Descriptions, Drawer, Select, Space, Table, Tag, Typography, message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import { hasPermission } from '../lib/permissions';
import type { Actor } from '../types/session';
import {
  compactJson,
  containsSensitiveAlertField,
  severityColor,
  statusColor,
  type AlertItem,
  type AlertSeverity,
  type AlertStatus,
} from './alerts-utils';

type Props = {
  actor: Actor;
  onNavigate: (path: string) => void;
};

const STATUS_OPTIONS: AlertStatus[] = ['active', 'resolved', 'silenced'];
const SEVERITY_OPTIONS: AlertSeverity[] = ['critical', 'warning', 'info'];

export function AlertsPage({ actor, onNavigate }: Props) {
  const canManage = hasPermission(actor, 'alerts.manage');
  const [items, setItems] = useState<AlertItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState<AlertStatus | undefined>();
  const [severity, setSeverity] = useState<AlertSeverity | undefined>();
  const [source, setSource] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AlertItem | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (status) params.set('status', status);
    if (severity) params.set('severity', severity);
    if (source) params.set('source', source);
    try {
      const result = await apiClient.request<{ total: number; items: AlertItem[] }>(`/alerts?${params.toString()}`);
      if (containsSensitiveAlertField(result)) {
        setItems([]);
        setError('告警 API 返回包含敏感字段，页面已阻止渲染。');
        return;
      }
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '告警加载失败。');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, severity, source, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const sources = useMemo(() => Array.from(new Set(items.map((item) => item.source))).sort(), [items]);

  const scan = async () => {
    setLoading(true);
    try {
      const result = await apiClient.request<{ generated: number; reactivated: number; resolved: number; notificationsCreated: number }>('/alerts/scan', { method: 'POST' });
      messageApi.success(`扫描完成：新增 ${result.generated}，重新激活 ${result.reactivated}，恢复 ${result.resolved}，通知 ${result.notificationsCreated}`);
      await load();
    } catch (err) {
      messageApi.error(err instanceof ApiError ? err.message : '扫描失败。');
    } finally {
      setLoading(false);
    }
  };

  const acknowledge = async (id: string) => {
    await apiClient.request(`/alerts/${encodeURIComponent(id)}/acknowledge`, { method: 'POST' });
    messageApi.success('已确认告警。');
    await load();
  };

  const silence = async (id: string) => {
    await apiClient.request(`/alerts/${encodeURIComponent(id)}/silence`, { method: 'POST', body: JSON.stringify({ minutes: 60 }) });
    messageApi.success('已静默 60 分钟。');
    await load();
  };

  return (
    <div className="page-section alerts-page" data-testid="alerts-page">
      {contextHolder}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>告警中心</Typography.Title>
          <Typography.Text type="secondary">只读查看系统健康、同步任务、凭证、锁账和审计风险生成的站内告警。</Typography.Text>
        </div>
        <Space wrap>
          <Button onClick={() => onNavigate('/system-health')}>系统健康</Button>
          <Button onClick={() => onNavigate('/data-sync')}>运行台</Button>
          <Button onClick={() => onNavigate('/audit-logs')}>审计中心</Button>
          {canManage ? <Button type="primary" loading={loading} onClick={scan} data-testid="alerts-scan">扫描</Button> : null}
        </Space>
      </div>

      {error ? <Alert className="data-page-notice" type="error" message={error} /> : null}

      <Space className="data-filter" wrap>
        <Select
          allowClear
          value={status}
          placeholder="状态"
          style={{ width: 150 }}
          options={STATUS_OPTIONS.map((value) => ({ value, label: value }))}
          onChange={(value) => { setStatus(value); setPage(1); }}
        />
        <Select
          allowClear
          value={severity}
          placeholder="级别"
          style={{ width: 150 }}
          options={SEVERITY_OPTIONS.map((value) => ({ value, label: value }))}
          onChange={(value) => { setSeverity(value); setPage(1); }}
        />
        <Select
          allowClear
          value={source}
          placeholder="来源"
          style={{ width: 180 }}
          options={sources.map((value) => ({ value, label: value }))}
          onChange={(value) => { setSource(value); setPage(1); }}
        />
        <Button onClick={load}>刷新</Button>
      </Space>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{ current: page, pageSize, total, onChange: (nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); } }}
        columns={[
          { title: '级别', dataIndex: 'severity', render: (value: AlertSeverity) => <Tag color={severityColor(value)}>{value}</Tag> },
          { title: '状态', dataIndex: 'status', render: (value: AlertStatus) => <Tag color={statusColor(value)}>{value}</Tag> },
          { title: '来源', dataIndex: 'source' },
          { title: '分类', dataIndex: 'category' },
          { title: '标题', dataIndex: 'title' },
          { title: '最近出现', dataIndex: 'lastSeenAt', render: (value: string) => new Date(value).toLocaleString() },
          {
            title: '操作',
            render: (_, record) => (
              <Space>
                <Button size="small" onClick={() => setSelected(record)}>详情</Button>
                {canManage && !record.acknowledgedAt ? <Button size="small" onClick={() => acknowledge(record.id)}>确认</Button> : null}
                {canManage && record.status !== 'silenced' ? <Button size="small" onClick={() => silence(record.id)}>静默</Button> : null}
              </Space>
            ),
          },
        ]}
      />

      <Drawer width={560} title="告警详情" open={Boolean(selected)} onClose={() => setSelected(null)}>
        {selected ? (
          <Space direction="vertical" size={16} className="page-stack">
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="级别"><Tag color={severityColor(selected.severity)}>{selected.severity}</Tag></Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color={statusColor(selected.status)}>{selected.status}</Tag></Descriptions.Item>
              <Descriptions.Item label="标题">{selected.title}</Descriptions.Item>
              <Descriptions.Item label="摘要">{selected.safeMessage}</Descriptions.Item>
              <Descriptions.Item label="fingerprint">{selected.fingerprint}</Descriptions.Item>
              <Descriptions.Item label="首次出现">{new Date(selected.firstSeenAt).toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="最近出现">{new Date(selected.lastSeenAt).toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="确认时间">{selected.acknowledgedAt ? new Date(selected.acknowledgedAt).toLocaleString() : '-'}</Descriptions.Item>
              <Descriptions.Item label="静默到">{selected.silencedUntil ? new Date(selected.silencedUntil).toLocaleString() : '-'}</Descriptions.Item>
            </Descriptions>
            <pre className="audit-json">{compactJson(selected.safeDetails)}</pre>
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
