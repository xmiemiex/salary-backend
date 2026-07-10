import { Alert, Button, Descriptions, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import type { Actor } from '../types/session';
import {
  auditResultTag,
  buildAuditLogsExportQuery,
  buildAuditLogsQuery,
  canExportAuditLogs,
  createLatestRequestGuard,
  defaultAuditLogFilters,
  fallbackAuditLogsFilename,
  moduleLabel,
  parseSafeAsciiFilename,
  safeAuditJsonText,
  setupAuditLogRequestLifecycle,
  triggerBlobDownload,
  validateAuditLogsRange,
  type AuditLogFilters,
} from './audit-log-utils';

type AuditLogRow = {
  id: string;
  createdAt: string;
  actorUserId?: string | null;
  actorUsername?: string | null;
  actorRole?: string | null;
  action: string;
  module: string;
  objectType: string;
  objectId?: string | null;
  result: string;
  summary?: string | null;
  ipAddress?: string | null;
  userAgentSummary?: string | null;
  settlementMonth?: string | null;
  requestId?: string | null;
  traceId?: string | null;
};

type AuditLogDetail = AuditLogRow & {
  beforeDataSummary?: string;
  afterDataSummary?: string;
  requestPayloadSummary?: string;
  changedFields?: string[];
  failureReason?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  relatedLinks?: Array<{ label: string; path: string }>;
  sanitizedRaw?: unknown;
};

type AuditLogsPayload = { items: AuditLogRow[]; total: number; page: number; pageSize: number };
const DEFAULT_PAGE_SIZE = 20;

function DownloadIcon() {
  return <span aria-hidden="true">↓</span>;
}

function requestError(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return '请求失败，请稍后重试。';
}

function displayTime(value: unknown): string {
  if (typeof value !== 'string' || !value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function displayMonth(value: unknown): string {
  return typeof value === 'string' && value ? value.slice(0, 7) : '-';
}

function fullText(value: unknown) {
  const text = typeof value === 'string' && value ? value : '-';
  return <Typography.Text ellipsis={{ tooltip: text }}>{text}</Typography.Text>;
}

function valueText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  return String(value);
}

export function AuditLogsPage({ actor }: { actor: Actor }) {
  const [form] = Form.useForm<AuditLogFilters>();
  const initialFilters = useMemo(() => defaultAuditLogFilters(), []);
  const [filters, setFilters] = useState<AuditLogFilters>(initialFilters);
  const [items, setItems] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detail, setDetail] = useState<AuditLogDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const listGuard = useRef(createLatestRequestGuard());
  const detailGuard = useRef(createLatestRequestGuard());
  const mounted = useRef(true);
  const downloadCleanups = useRef(new Set<() => void>());
  const canExport = canExportAuditLogs(actor);

  const loadList = useCallback(async (nextFilters: AuditLogFilters, nextPage: number, nextPageSize: number) => {
    const validation = validateAuditLogsRange(nextFilters);
    if (validation) {
      setListError(validation);
      return;
    }
    const requestId = listGuard.current.begin();
    setLoading(true);
    setListError(null);
    try {
      const query = buildAuditLogsQuery(nextFilters, nextPage, nextPageSize);
      const payload = await apiClient.request<AuditLogsPayload>(`/audit-logs?${query}`);
      if (!mounted.current || !listGuard.current.isCurrent(requestId)) return;
      setItems(Array.isArray(payload.items) ? payload.items : []);
      setTotal(payload.total ?? 0);
      setPage(payload.page ?? nextPage);
      setPageSize(payload.pageSize ?? nextPageSize);
    } catch (error) {
      if (!mounted.current || !listGuard.current.isCurrent(requestId)) return;
      setListError(requestError(error));
    } finally {
      if (mounted.current && listGuard.current.isCurrent(requestId)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const cleanup = setupAuditLogRequestLifecycle(mounted, listGuard.current, detailGuard.current);
    form.setFieldsValue(initialFilters);
    void loadList(initialFilters, 1, DEFAULT_PAGE_SIZE);
    return () => {
      cleanup();
      downloadCleanups.current.forEach((revoke) => revoke());
      downloadCleanups.current.clear();
    };
  }, [form, initialFilters, loadList]);

  const exportCsv = useCallback(async () => {
    if (!canExport || exportLoading) return;
    const validation = validateAuditLogsRange(filters);
    if (validation) {
      setExportError(validation);
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: '导出审计日志',
        content: '只会导出当前筛选条件下最多 10,000 行脱敏 CSV。',
        okText: '导出',
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    if (!confirmed) return;

    setExportLoading(true);
    setExportError(null);
    try {
      const query = buildAuditLogsExportQuery(filters);
      const result = await apiClient.download(`/audit-logs/export.csv${query ? `?${query}` : ''}`);
      if (!mounted.current) return;
      const filename = parseSafeAsciiFilename(result.contentDisposition) ?? fallbackAuditLogsFilename();
      const revoke = triggerBlobDownload(result.blob, filename);
      downloadCleanups.current.add(revoke);
      message.success('CSV 已导出。');
    } catch (error) {
      if (mounted.current) setExportError(requestError(error));
    } finally {
      if (mounted.current) setExportLoading(false);
    }
  }, [canExport, exportLoading, filters]);

  const openDetail = useCallback(async (id: string) => {
    const requestId = detailGuard.current.begin();
    setDrawerOpen(true);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const payload = await apiClient.request<AuditLogDetail>(`/audit-logs/${id}`);
      if (!mounted.current || !detailGuard.current.isCurrent(requestId)) return;
      setDetail(payload);
    } catch (error) {
      if (!mounted.current || !detailGuard.current.isCurrent(requestId)) return;
      setDetailError(requestError(error));
    } finally {
      if (mounted.current && detailGuard.current.isCurrent(requestId)) setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    detailGuard.current.invalidate();
    setDrawerOpen(false);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, []);

  const columns = useMemo<ColumnsType<AuditLogRow>>(() => [
    { title: '时间', dataIndex: 'createdAt', width: 180, render: displayTime },
    { title: '操作者', dataIndex: 'actorUsername', width: 150, render: (_, record) => fullText(record.actorUsername || record.actorUserId) },
    { title: '角色', dataIndex: 'actorRole', width: 120, render: fullText },
    { title: '动作', dataIndex: 'action', width: 210, render: fullText },
    { title: '模块', dataIndex: 'module', width: 130, render: moduleLabel },
    { title: '对象类型', dataIndex: 'objectType', width: 150, render: fullText },
    { title: '对象 ID', dataIndex: 'objectId', width: 220, render: fullText },
    { title: '结果', dataIndex: 'result', width: 100, render: (value) => { const tag = auditResultTag(value); return <Tag color={tag.color}>{tag.text}</Tag>; } },
    { title: '安全摘要', dataIndex: 'summary', width: 280, render: fullText },
    { title: 'IP', dataIndex: 'ipAddress', width: 140, render: fullText },
    { title: 'UA 简要', dataIndex: 'userAgentSummary', width: 220, render: fullText },
    { title: '操作', key: 'operation', fixed: 'right', width: 100, render: (_, record) => <Button type="link" onClick={() => void openDetail(record.id)}>详情</Button> },
  ], [openDetail]);

  return (
    <section className="page-section data-page">
      <div className="data-page-header">
        <div>
          <Typography.Title level={3}>审计中心</Typography.Title>
          <Typography.Text type="secondary">按操作者、模块、动作、对象、结果和时间检索审计日志。</Typography.Text>
        </div>
        <Space>
          {canExport ? <Button icon={<DownloadIcon />} loading={exportLoading} disabled={exportLoading} onClick={() => void exportCsv()}>导出 CSV</Button> : null}
          <Button loading={loading} onClick={() => void loadList(filters, page, pageSize)}>刷新</Button>
        </Space>
      </div>
      <Form form={form} layout="inline" className="data-filter" initialValues={initialFilters} onFinish={(values) => { setFilters(values); setPage(1); void loadList(values, 1, pageSize); }}>
        <Form.Item name="createdFrom" label="开始时间"><Input type="datetime-local" /></Form.Item>
        <Form.Item name="createdTo" label="结束时间"><Input type="datetime-local" /></Form.Item>
        <Form.Item name="actorUserId" label="操作者ID"><Input allowClear /></Form.Item>
        <Form.Item name="actorUsername" label="用户名"><Input allowClear /></Form.Item>
        <Form.Item name="actorRole" label="角色"><Input allowClear /></Form.Item>
        <Form.Item name="action" label="动作"><Input allowClear /></Form.Item>
        <Form.Item name="module" label="模块">
          <Select allowClear style={{ width: 150 }} options={[
            { value: 'auth', label: '认证' },
            { value: 'admin_users', label: '管理员' },
            { value: 'roles', label: '角色' },
            { value: 'sync_planning', label: '同步规划' },
            { value: 'sync_execution', label: '同步执行' },
            { value: 'sync_operations', label: '同步运行台' },
            { value: 'dashboard', label: '运营总览' },
            { value: 'credentials', label: '凭证' },
            { value: 'system', label: '系统' },
            { value: 'other', label: '其他' },
          ]} />
        </Form.Item>
        <Form.Item name="objectType" label="对象类型"><Input allowClear /></Form.Item>
        <Form.Item name="objectId" label="对象ID"><Input allowClear /></Form.Item>
        <Form.Item name="result" label="结果"><Select allowClear style={{ width: 120 }} options={[{ value: 'success' }, { value: 'failure' }]} /></Form.Item>
        <Form.Item name="settlementMonth" label="月份"><Input type="month" /></Form.Item>
        <Form.Item name="requestId" label="requestId"><Input allowClear /></Form.Item>
        <Form.Item name="traceId" label="traceId"><Input allowClear /></Form.Item>
        <Form.Item name="ip" label="IP"><Input allowClear /></Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">查询</Button>
            <Button onClick={() => { const next = defaultAuditLogFilters(); form.setFieldsValue(next); setFilters(next); setPage(1); void loadList(next, 1, pageSize); }}>重置</Button>
          </Space>
        </Form.Item>
      </Form>
      {listError ? <Alert className="data-page-notice" type="error" showIcon message="审计日志加载失败" description={listError} /> : null}
      {exportError ? <Alert className="data-page-notice" type="error" showIcon message="CSV 导出失败" description={exportError} closable onClose={() => setExportError(null)} /> : null}
      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={items}
        scroll={{ x: 2300 }}
        locale={{ emptyText: listError ? '加载失败' : '暂无审计日志' }}
        pagination={{ current: page, pageSize, total, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100], showTotal: (value) => `共 ${value} 条` }}
        onChange={(pagination: TablePaginationConfig) => {
          const nextSize = pagination.pageSize ?? DEFAULT_PAGE_SIZE;
          const nextPage = nextSize !== pageSize ? 1 : pagination.current ?? 1;
          void loadList(filters, nextPage, nextSize);
        }}
      />
      <Drawer title="审计日志详情" width="min(920px, 92vw)" open={drawerOpen} onClose={closeDetail} destroyOnClose loading={detailLoading}>
        {detailError ? <Alert type="error" showIcon message="详情加载失败" description={detailError} /> : null}
        {detail ? <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="id" span={2}>{detail.id}</Descriptions.Item>
            <Descriptions.Item label="时间">{displayTime(detail.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="结果">{auditResultTag(detail.result).text}</Descriptions.Item>
            <Descriptions.Item label="操作者" span={2}>{`${detail.actorUsername ?? '-'} / ${detail.actorUserId ?? '-'} / ${detail.actorRole ?? '-'}`}</Descriptions.Item>
            <Descriptions.Item label="动作">{valueText(detail.action)}</Descriptions.Item>
            <Descriptions.Item label="模块">{moduleLabel(detail.module)}</Descriptions.Item>
            <Descriptions.Item label="对象" span={2}>{`${detail.objectType ?? '-'} / ${detail.objectId ?? '-'}`}</Descriptions.Item>
            <Descriptions.Item label="月份">{displayMonth(detail.settlementMonth)}</Descriptions.Item>
            <Descriptions.Item label="IP">{valueText(detail.ipAddress)}</Descriptions.Item>
            <Descriptions.Item label="requestId">{valueText(detail.requestId)}</Descriptions.Item>
            <Descriptions.Item label="traceId">{valueText(detail.traceId)}</Descriptions.Item>
            <Descriptions.Item label="failureReason">{valueText(detail.failureReason)}</Descriptions.Item>
            <Descriptions.Item label="errorCode">{valueText(detail.errorCode)}</Descriptions.Item>
            <Descriptions.Item label="errorMessage" span={2}>{valueText(detail.errorMessage)}</Descriptions.Item>
            <Descriptions.Item label="changedFields" span={2}>{valueText(detail.changedFields)}</Descriptions.Item>
            <Descriptions.Item label="UA 简要" span={2}>{valueText(detail.userAgentSummary)}</Descriptions.Item>
            <Descriptions.Item label="关联对象" span={2}>{detail.relatedLinks?.length ? detail.relatedLinks.map((link) => link.label).join(', ') : '-'}</Descriptions.Item>
          </Descriptions>
          {(['beforeDataSummary', 'afterDataSummary', 'requestPayloadSummary'] as const).map((field) => (
            <div key={field}>
              <Typography.Title level={5}>{field}</Typography.Title>
              <pre className="audit-json">{valueText(detail[field])}</pre>
            </div>
          ))}
          <div>
            <Typography.Title level={5}>sanitizedRaw</Typography.Title>
            <pre className="audit-json">{safeAuditJsonText(detail.sanitizedRaw)}</pre>
          </div>
        </Space> : null}
      </Drawer>
    </section>
  );
}
