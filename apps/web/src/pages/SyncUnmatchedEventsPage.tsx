import { Alert, Button, Form, Input, Modal, Select, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import {
  SOURCE_TYPE_OPTIONS,
  UNMATCHED_PLATFORM_OPTIONS,
  UNMATCHED_PROVIDER_OPTIONS,
  UNMATCHED_REASON_OPTIONS,
  UNMATCHED_STATUS_OPTIONS,
  buildSyncUnmatchedEventsQuery,
  countValue,
  formatSettlementMonth,
  formatUnmatchedDateTime,
  isPendingUnmatchedEvent,
  rawSafeDataText,
  uiStatusFromApi,
  unmatchedStatusColor,
  type SyncUnmatchedEventFilters,
  type SyncUnmatchedEventRow,
  type SyncUnmatchedSummary,
} from './sync-unmatched-events-utils';
import { defaultGmt8Month, textValue } from './sync-reconciliation-utils';

type EmployeeOption = {
  id: string;
  name?: string | null;
  employeeCode?: string | null;
};

type SyncUnmatchedEventsPayload = {
  items: SyncUnmatchedEventRow[];
  total: number;
  page: number;
  pageSize: number;
  summary?: SyncUnmatchedSummary;
};

const DEFAULT_PAGE_SIZE = 20;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试。';
}

function employeeLabel(employee: EmployeeOption): string {
  const code = employee.employeeCode ? ` / ${employee.employeeCode}` : '';
  return `${employee.name ?? employee.id}${code} / ${employee.id}`;
}

function SummaryStats({ summary, total }: { summary?: SyncUnmatchedSummary; total: number }) {
  if (!summary) return null;

  const pendingCount = summary.pendingCount ?? summary.openCount;
  const reasonEntries = Object.entries(summary.byReasonCode ?? {});

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div className="reconciliation-summary">
        <Statistic title="总数量" value={countValue(summary.totalCount ?? total)} />
        <Statistic title="pending 数量" value={countValue(pendingCount)} />
        <Statistic title="ignored 数量" value={countValue(summary.ignoredCount)} />
        <Statistic title="resolved 数量" value={countValue(summary.resolvedCount)} />
        {summary.totalAmountUsd !== undefined ? <Statistic title="totalAmountUsd" value={textValue(summary.totalAmountUsd)} /> : null}
      </div>
      {reasonEntries.length ? (
        <div className="reconciliation-summary">
          {reasonEntries.map(([reasonCode, count]) => (
            <Statistic key={reasonCode} title={reasonCode} value={count} />
          ))}
        </div>
      ) : null}
    </Space>
  );
}

export function SyncUnmatchedEventsPage() {
  const [form] = Form.useForm<SyncUnmatchedEventFilters>();
  const [messageApi, messageHolder] = message.useMessage();
  const [modalApi, modalHolder] = Modal.useModal();
  const [rows, setRows] = useState<SyncUnmatchedEventRow[]>([]);
  const [summary, setSummary] = useState<SyncUnmatchedSummary | undefined>();
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [filters, setFilters] = useState<SyncUnmatchedEventFilters>(() => ({ settlementMonth: defaultGmt8Month(), status: 'pending' }));
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [operatingId, setOperatingId] = useState<string | null>(null);

  const loadEmployees = useCallback(async () => {
    try {
      const payload = await apiClient.request<EmployeeOption[]>('/employees?status=active');
      setEmployees(payload);
    } catch (error) {
      messageApi.error(errorMessage(error));
    }
  }, [messageApi]);

  const loadEvents = useCallback(
    async (nextPage: number, nextPageSize: number, nextFilters: SyncUnmatchedEventFilters) => {
      if (!nextFilters.settlementMonth) return;
      setLoading(true);
      try {
        const query = buildSyncUnmatchedEventsQuery(nextFilters, nextPage, nextPageSize);
        const payload = await apiClient.request<SyncUnmatchedEventsPayload>(`/sync-unmatched-events?${query}`);
        setRows(payload.items);
        setTotal(payload.total);
        setPage(payload.page);
        setPageSize(payload.pageSize);
        setSummary(payload.summary);
      } catch (error) {
        messageApi.error(errorMessage(error));
      } finally {
        setLoading(false);
      }
    },
    [messageApi],
  );

  useEffect(() => {
    form.setFieldsValue(filters);
  }, [filters, form]);

  useEffect(() => {
    void loadEmployees();
  }, [loadEmployees]);

  useEffect(() => {
    void loadEvents(1, pageSize, filters);
  }, [filters, loadEvents, pageSize]);

  const refreshCurrent = useCallback(async () => {
    await loadEvents(page, pageSize, filters);
  }, [filters, loadEvents, page, pageSize]);

  const ignoreEvent = useCallback(
    (record: SyncUnmatchedEventRow) => {
      modalApi.confirm({
        title: '确认忽略未匹配事件？',
        content: (
          <Space direction="vertical" size={4}>
            <Typography.Text>第三方事件ID：{textValue(record.thirdPartyEventId)}</Typography.Text>
            <Typography.Text>原因：{textValue(record.reasonCode)}</Typography.Text>
            <Typography.Text type="secondary">此操作只修改未匹配事件处理状态，不回补正式收入或卡花费数据。</Typography.Text>
          </Space>
        ),
        okText: '忽略',
        cancelText: '取消',
        async onOk() {
          setOperatingId(record.id);
          try {
            await apiClient.request<SyncUnmatchedEventRow>(`/sync-unmatched-events/${record.id}/ignore`, {
              method: 'POST',
              body: JSON.stringify({}),
            });
            messageApi.success('已忽略。');
            await refreshCurrent();
          } catch (error) {
            messageApi.error(errorMessage(error));
          } finally {
            setOperatingId(null);
          }
        },
      });
    },
    [messageApi, modalApi, refreshCurrent],
  );

  const resolveEvent = useCallback(
    (record: SyncUnmatchedEventRow) => {
      let resolvedEmployeeId: string | undefined;

      modalApi.confirm({
        title: '确认标记为已处理？',
        content: (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text>第三方事件ID：{textValue(record.thirdPartyEventId)}</Typography.Text>
            <Typography.Text>原因：{textValue(record.reasonCode)}</Typography.Text>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择处理归属员工"
              style={{ width: '100%' }}
              options={employees.map((employee) => ({ value: employee.id, label: employeeLabel(employee) }))}
              onChange={(value) => {
                resolvedEmployeeId = value;
              }}
            />
            <Typography.Text type="secondary">此操作只记录处理状态和员工备注，不写入正式收入或卡花费表。</Typography.Text>
          </Space>
        ),
        okText: '标记已处理',
        cancelText: '取消',
        async onOk() {
          if (!resolvedEmployeeId) {
            throw new Error('请选择处理归属员工。');
          }
          setOperatingId(record.id);
          try {
            await apiClient.request<SyncUnmatchedEventRow>(`/sync-unmatched-events/${record.id}/resolve`, {
              method: 'POST',
              body: JSON.stringify({ resolvedEmployeeId }),
            });
            messageApi.success('已标记为已处理。');
            await refreshCurrent();
          } catch (error) {
            messageApi.error(errorMessage(error));
          } finally {
            setOperatingId(null);
          }
        },
      });
    },
    [employees, messageApi, modalApi, refreshCurrent],
  );

  const columns = useMemo<ColumnsType<SyncUnmatchedEventRow>>(
    () => [
      { title: '结算月份', dataIndex: 'settlementMonth', key: 'settlementMonth', width: 120, render: formatSettlementMonth },
      { title: 'sourceType', dataIndex: 'sourceType', key: 'sourceType', width: 150, render: textValue },
      { title: 'platform', dataIndex: 'platform', key: 'platform', width: 120, render: textValue },
      { title: 'provider', dataIndex: 'provider', key: 'provider', width: 120, render: textValue },
      { title: 'reasonCode', dataIndex: 'reasonCode', key: 'reasonCode', width: 180, render: (value) => <Tag color="orange">{textValue(value)}</Tag> },
      { title: 'reasonMessage', dataIndex: 'reasonMessage', key: 'reasonMessage', width: 280, render: textValue },
      { title: 'thirdPartyEventId', dataIndex: 'thirdPartyEventId', key: 'thirdPartyEventId', width: 220, render: textValue },
      { title: 'subField', dataIndex: 'subField', key: 'subField', width: 120, render: textValue },
      { title: 'subValue', dataIndex: 'subValue', key: 'subValue', width: 180, render: textValue },
      { title: 'cardId', dataIndex: 'cardId', key: 'cardId', width: 180, render: textValue },
      { title: 'cardLast4', dataIndex: 'cardLast4', key: 'cardLast4', width: 120, render: textValue },
      { title: 'cardEmail', dataIndex: 'cardEmail', key: 'cardEmail', width: 220, render: textValue },
      { title: 'amountUsd', dataIndex: 'amountUsd', key: 'amountUsd', width: 120, render: textValue },
      { title: 'currency', dataIndex: 'currency', key: 'currency', width: 100, render: textValue },
      { title: 'occurredAt', dataIndex: 'occurredAt', key: 'occurredAt', width: 180, render: formatUnmatchedDateTime },
      {
        title: 'status',
        dataIndex: 'status',
        key: 'status',
        width: 120,
        render: (value) => <Tag color={unmatchedStatusColor(value)}>{uiStatusFromApi(value)}</Tag>,
      },
      { title: 'createdAt', dataIndex: 'createdAt', key: 'createdAt', width: 180, render: formatUnmatchedDateTime },
      { title: 'resolvedBy', dataIndex: 'resolvedBy', key: 'resolvedBy', width: 160, render: textValue },
      { title: 'resolvedAt', dataIndex: 'resolvedAt', key: 'resolvedAt', width: 180, render: formatUnmatchedDateTime },
      {
        title: 'rawSafeData',
        key: 'rawSafeData',
        width: 130,
        render: (_, record) => (
          <Button
            size="small"
            onClick={() =>
              modalApi.info({
                title: 'rawSafeData',
                width: 760,
                content: <pre style={{ maxHeight: 520, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{rawSafeDataText(record.rawSafeData)}</pre>,
              })
            }
          >
            查看
          </Button>
        ),
      },
      {
        title: '操作',
        key: 'operation',
        fixed: 'right',
        width: 180,
        render: (_, record) =>
          isPendingUnmatchedEvent(record) ? (
            <Space>
              <Button size="small" loading={operatingId === record.id} onClick={() => ignoreEvent(record)}>
                忽略
              </Button>
              <Button size="small" type="primary" loading={operatingId === record.id} onClick={() => resolveEvent(record)}>
                已处理
              </Button>
            </Space>
          ) : null,
      },
    ],
    [ignoreEvent, modalApi, operatingId, resolveEvent],
  );

  return (
    <section className="page-section data-page">
      {messageHolder}
      {modalHolder}
      <div className="data-page-header">
        <div>
          <Typography.Title level={3}>未匹配事件</Typography.Title>
          <Typography.Text type="secondary">
            查看真实同步拉到但未能入正式收入/卡花费表的记录；本页只管理处理状态，不参与工资计算。
          </Typography.Text>
        </div>
        <Button onClick={() => void refreshCurrent()} loading={loading}>
          刷新
        </Button>
      </div>

      <Alert
        className="data-page-notice"
        type="info"
        showIcon
        message="处理说明"
        description="锁账月份仍可查看；忽略或标记已处理只更新 sync_unmatched_events 状态，不改变锁账规则，也不会自动回补正式数据。"
      />

      <Form
        form={form}
        layout="inline"
        className="data-filter"
        onFinish={(values) => {
          const nextFilters = values as SyncUnmatchedEventFilters;
          setFilters(nextFilters);
          setPage(1);
        }}
      >
        <Form.Item name="settlementMonth" label="结算月份" rules={[{ required: true, message: '请选择结算月份' }]}>
          <Input type="month" />
        </Form.Item>
        <Form.Item name="sourceType" label="sourceType">
          <Select allowClear style={{ width: 180 }} options={[...SOURCE_TYPE_OPTIONS]} />
        </Form.Item>
        <Form.Item name="platform" label="platform">
          <Select allowClear style={{ width: 160 }} options={[...UNMATCHED_PLATFORM_OPTIONS]} />
        </Form.Item>
        <Form.Item name="provider" label="provider">
          <Select allowClear style={{ width: 160 }} options={[...UNMATCHED_PROVIDER_OPTIONS]} />
        </Form.Item>
        <Form.Item name="reasonCode" label="reasonCode">
          <Select allowClear showSearch style={{ width: 240 }} options={UNMATCHED_REASON_OPTIONS} />
        </Form.Item>
        <Form.Item name="status" label="status">
          <Select allowClear style={{ width: 160 }} options={[...UNMATCHED_STATUS_OPTIONS]} />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">
              查询
            </Button>
            <Button
              onClick={() => {
                const nextFilters = { settlementMonth: defaultGmt8Month(), status: 'pending' as const };
                form.setFieldsValue(nextFilters);
                setFilters(nextFilters);
                setPage(1);
              }}
            >
              重置
            </Button>
          </Space>
        </Form.Item>
      </Form>

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <SummaryStats summary={summary} total={total} />
        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows}
          loading={loading}
          scroll={{ x: 'max-content' }}
          pagination={{ current: page, pageSize, total, showSizeChanger: true }}
          onChange={(pagination: TablePaginationConfig) =>
            void loadEvents(pagination.current ?? 1, pagination.pageSize ?? DEFAULT_PAGE_SIZE, filters)
          }
          locale={{ emptyText: '暂无未匹配事件' }}
        />
      </Space>
    </section>
  );
}
