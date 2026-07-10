import { Alert, Button, Space, Table, Tag, Typography, message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import { hasPermission } from '../lib/permissions';
import type { Actor } from '../types/session';
import {
  containsSensitiveReleaseGateField,
  groupReleaseGateChecks,
  releaseGateStatusColor,
  releaseGateStatusLabel,
  safeReleaseGateDetails,
  type ReleaseGateCheck,
  type ReleaseGateResponse,
} from './release-gate-utils';

type Props = {
  actor: Actor;
};

export function ReleaseGatePage({ actor }: Props) {
  const canRun = hasPermission(actor, 'release_gate.run');
  const [data, setData] = useState<ReleaseGateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await apiClient.request<ReleaseGateResponse>('/release-gate');
      if (containsSensitiveReleaseGateField(next)) {
        setData(null);
        setError('发布门禁 API 返回包含敏感字段，页面已阻止渲染。');
        return;
      }
      setData(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '发布门禁加载失败。');
    } finally {
      setLoading(false);
    }
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const next = await apiClient.request<ReleaseGateResponse>('/release-gate/run', { method: 'POST' });
      if (containsSensitiveReleaseGateField(next)) {
        setData(null);
        setError('发布门禁运行结果包含敏感字段，页面已阻止渲染。');
        return;
      }
      setData(next);
      messageApi.success('发布门禁检查已完成。');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '发布门禁运行失败。');
    } finally {
      setRunning(false);
    }
  }, [messageApi]);

  useEffect(() => {
    void load();
  }, [load]);

  const requiredChecks = useMemo(() => groupReleaseGateChecks(data?.checks ?? [], 'required'), [data]);
  const recommendedChecks = useMemo(() => groupReleaseGateChecks(data?.checks ?? [], 'recommended'), [data]);
  const remediationChecks = useMemo(() => (data?.checks ?? []).filter((item) => item.status !== 'pass'), [data]);

  return (
    <div className="page-section release-gate-page" data-testid="release-gate-page">
      {contextHolder}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>发布门禁 / 上线检查</Typography.Title>
          <Typography.Text type="secondary">只读汇总生产上线前必须通过的配置、权限、审计、告警、备份、E2E 和迁移确认项。</Typography.Text>
        </div>
        <Space wrap>
          <Button onClick={load} loading={loading} data-testid="release-gate-refresh">刷新</Button>
          {canRun ? <Button type="primary" onClick={run} loading={running} data-testid="release-gate-run">运行检查</Button> : null}
        </Space>
      </div>

      {error ? <Alert className="data-page-notice" type="error" message={error} data-testid="release-gate-error" /> : null}

      <section className="health-panel" data-testid="release-gate-summary">
        <Typography.Title level={3}>总体状态</Typography.Title>
        <Space size={12} wrap>
          <Tag color={releaseGateStatusColor(data?.status ?? 'warning')}>{releaseGateStatusLabel(data?.status ?? 'warning')}</Tag>
          <span>通过：{data?.summary.pass ?? 0}</span>
          <span>警告：{data?.summary.warning ?? 0}</span>
          <span>失败：{data?.summary.fail ?? 0}</span>
          <span className="muted-text">最近检查时间：{data?.generatedAt ?? '-'}</span>
        </Space>
      </section>

      <CheckSection title="必须通过项" checks={requiredChecks} testId="release-gate-required" />
      <CheckSection title="建议检查项" checks={recommendedChecks} testId="release-gate-recommended" />

      <section className="health-panel" data-testid="release-gate-remediation">
        <Typography.Title level={3}>修复建议</Typography.Title>
        {remediationChecks.length ? (
          <div className="health-list">
            {remediationChecks.map((item) => (
              <div className="health-list-row" key={`remediation-${item.code}`}>
                <Tag color={releaseGateStatusColor(item.status)}>{releaseGateStatusLabel(item.status)}</Tag>
                <span>{item.code}</span>
                <span>{item.remediation}</span>
              </div>
            ))}
          </div>
        ) : (
          <Typography.Text type="secondary">暂无需要处理的检查项。</Typography.Text>
        )}
      </section>
    </div>
  );
}

function CheckSection({ title, checks, testId }: { title: string; checks: ReleaseGateCheck[]; testId: string }) {
  return (
    <section className="health-panel" data-testid={testId}>
      <Typography.Title level={3}>{title}</Typography.Title>
      <Table
        rowKey="code"
        dataSource={checks}
        pagination={false}
        columns={[
          { title: '状态', dataIndex: 'status', render: (value) => <Tag color={releaseGateStatusColor(value)}>{releaseGateStatusLabel(value)}</Tag> },
          { title: '代码', dataIndex: 'code' },
          { title: '标题', dataIndex: 'title' },
          { title: '说明', dataIndex: 'message' },
          { title: '安全摘要', dataIndex: 'safeDetails', render: safeReleaseGateDetails },
        ]}
      />
    </section>
  );
}
