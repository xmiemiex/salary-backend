import { Alert, Button, Descriptions, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import { hasPermission } from '../lib/permissions';
import type { Actor } from '../types/session';
import {
  formatPreflightDetails,
  formatPreflightSeverity,
  formatPreflightSummary,
  createLatestPreflightRequestGuard,
  buildSettlementGenerateBody,
  getGenerateDisabledReason,
  handleSettlementPrecheckFailure,
  isPreflightForMonth,
  isGenerateDisabled,
  preflightAlertType,
  preflightSeverityColor,
  shouldConfirmWarningGenerate,
  type SettlementGenerateRejection,
  type SettlementPreflightCheck,
  type SettlementPreflightResult,
  type WarningAcknowledgement,
} from './salary-settlement-utils';

type SettlementStatus = 'draft' | 'confirmed' | 'locked';
type AttendanceStatus = 'full_attendance' | 'sick_leave' | 'personal_leave' | 'absent' | 'other';

type SettlementSummary = {
  settlement: {
    id: string;
    settlementMonth: string;
    status: SettlementStatus;
    generatedAt?: string | null;
    generatedBy?: string | null;
    confirmedAt?: string | null;
    confirmedBy?: string | null;
    lockedAt?: string | null;
    lockedBy?: string | null;
    lockReason?: string | null;
  };
  detailCount: number;
  totalFinalSalaryRmb: string;
  totalCommissionRmb: string;
  totalGrossProfitUsd: string;
  status: SettlementStatus;
};

type SettlementDetail = {
  employeeId: string;
  incomeUsd: string;
  cardSpendUsd: string;
  grossProfitUsd: string;
  commissionRmb: string;
  manualAdditionRmb: string;
  manualDeductionRmb: string;
  finalSalaryRmb: string;
  attendanceStatus?: string | null;
  snapshot?: Record<string, unknown> | null;
};

type DetailPayload = {
  page: number;
  pageSize: number;
  total: number;
  items: SettlementDetail[];
};

type DetailQuery = {
  employeeId?: string;
  page?: number;
  pageSize?: number;
};

type AttendanceRow = {
  employeeId?: string;
  attendanceStatus?: AttendanceStatus;
};

const DEFAULT_PAGE_SIZE = 50;
const ATTENDANCE_STATUS_OPTIONS: { label: string; value: AttendanceStatus }[] = [
  { label: '全勤', value: 'full_attendance' },
  { label: '病假', value: 'sick_leave' },
  { label: '事假', value: 'personal_leave' },
  { label: '旷工', value: 'absent' },
  { label: '其他', value: 'other' },
];
const ATTENDANCE_STATUS_VALUES = new Set<AttendanceStatus>(
  ATTENDANCE_STATUS_OPTIONS.map((option) => option.value),
);

function currentGmt8Month(): string {
  const now = new Date();
  const gmt8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return `${gmt8.getUTCFullYear()}-${String(gmt8.getUTCMonth() + 1).padStart(2, '0')}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试。';
}

function statusColor(status: SettlementStatus | undefined): string {
  if (status === 'draft') return 'blue';
  if (status === 'confirmed') return 'green';
  if (status === 'locked') return 'red';
  return 'default';
}

function statusText(status: SettlementStatus | undefined): string {
  const map: Record<SettlementStatus, string> = {
    draft: '草稿',
    confirmed: '已确认',
    locked: '已锁账',
  };
  return status ? map[status] : '未生成';
}

function formatDateTime(value: unknown): string {
  return typeof value === 'string' && value ? value.replace('T', ' ').slice(0, 19) : '-';
}

function formatMonth(value: unknown): string {
  return typeof value === 'string' && value ? value.slice(0, 7) : '-';
}

function snapshotValue(detail: SettlementDetail, key: string): string {
  const value = detail.snapshot?.[key];
  if (value === null || value === undefined) return '';
  return String(value);
}

function nestedSnapshotValue(detail: SettlementDetail, group: string, key: string): string {
  const groupValue = detail.snapshot?.[group];
  if (!groupValue || typeof groupValue !== 'object') return '';
  const value = (groupValue as Record<string, unknown>)[key];
  if (value === null || value === undefined) return '';
  return String(value);
}

function fieldValue(detail: SettlementDetail, key: string, group?: string): string {
  return snapshotValue(detail, key) || (group ? nestedSnapshotValue(detail, group, key) : '');
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function buildQuery(query: DetailQuery): string {
  const params = new URLSearchParams();
  if (query.employeeId) params.set('employeeId', query.employeeId);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  return params.toString();
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function SalarySettlementPage({ actor }: { actor: Actor }) {
  const [generateForm] = Form.useForm<{ attendanceRows: AttendanceRow[] }>();
  const [month, setMonth] = useState(currentGmt8Month);
  const [summary, setSummary] = useState<SettlementSummary | null>(null);
  const [details, setDetails] = useState<SettlementDetail[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [employeeId, setEmployeeId] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generatePrecheckFailure, setGeneratePrecheckFailure] = useState<SettlementGenerateRejection | null>(null);
  const [warningAcknowledgement, setWarningAcknowledgement] = useState<WarningAcknowledgement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<SettlementPreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<SettlementDetail | null>(null);
  const [messageApi, messageHolder] = message.useMessage();
  const [modalApi, modalHolder] = Modal.useModal();
  const currentMonthRef = useRef(month);
  currentMonthRef.current = month;
  const preflightRequestGuardRef = useRef(
    createLatestPreflightRequestGuard(() => currentMonthRef.current),
  );

  const canViewPreflight = hasPermission(actor, 'salary.view_all');
  const canGenerate = hasPermission(actor, 'settlement.generate');
  const canConfirm = hasPermission(actor, 'settlement.generate');
  const canLock = hasPermission(actor, 'settlement.lock');
  const canExport = hasPermission(actor, 'salary.export');
  const isLocked = summary?.status === 'locked';
  const currentPreflight = isPreflightForMonth(preflight, month) ? preflight : null;
  const generateDisabledReason = getGenerateDisabledReason({
    hasGeneratePermission: canGenerate,
    isLocked,
    settlementMonth: month,
    preflight: currentPreflight,
  });
  const generateDisabled = isGenerateDisabled({
    hasGeneratePermission: canGenerate,
    isLocked,
    settlementMonth: month,
    preflight: currentPreflight,
  });

  const load = useCallback(
    async (nextPage = page, nextPageSize = pageSize, nextEmployeeId = employeeId) => {
      setLoading(true);
      setLoadError(null);
      try {
        const nextSummary = await apiClient.request<SettlementSummary>(`/settlements/${month}`);
        const query = buildQuery({ page: nextPage, pageSize: nextPageSize, employeeId: nextEmployeeId.trim() });
        const nextDetails = await apiClient.request<DetailPayload>(`/settlements/${month}/details?${query}`);
        setSummary(nextSummary);
        setDetails(nextDetails.items);
        setTotal(nextDetails.total);
        setPage(nextDetails.page);
        setPageSize(nextDetails.pageSize);
      } catch (error) {
        const nextMessage = errorMessage(error);
        setSummary(null);
        setDetails([]);
        setTotal(0);
        setLoadError(nextMessage);
        messageApi.error(nextMessage);
      } finally {
        setLoading(false);
      }
    },
    [employeeId, messageApi, month, page, pageSize],
  );

  const loadPreflight = useCallback(async () => {
    setWarningAcknowledgement(null);
    const requestedMonth = month;
    const requestGuard = preflightRequestGuardRef.current;
    if (!canViewPreflight) {
      requestGuard.invalidate();
      setPreflight(null);
      setPreflightError(null);
      setPreflightLoading(false);
      return;
    }

    const requestToken = requestGuard.begin(requestedMonth);
    setPreflight(null);
    setPreflightLoading(true);
    setPreflightError(null);
    try {
      const query = new URLSearchParams({ settlementMonth: requestedMonth }).toString();
      const nextPreflight = await apiClient.request<SettlementPreflightResult>(`/settlements/preflight?${query}`);
      if (!requestGuard.isCurrent(requestToken)) return;
      if (!isPreflightForMonth(nextPreflight, requestedMonth)) {
        setPreflight(null);
        setPreflightError('preflight 返回的结算月份与当前请求不一致。');
        return;
      }
      setPreflight(nextPreflight);
    } catch (error) {
      if (!requestGuard.isCurrent(requestToken)) return;
      const nextMessage = errorMessage(error);
      setPreflight(null);
      setPreflightError(nextMessage);
      messageApi.error(nextMessage);
    } finally {
      if (requestGuard.isCurrent(requestToken)) setPreflightLoading(false);
    }
  }, [canViewPreflight, messageApi, month]);

  const reloadPage = useCallback(async () => {
    await Promise.all([load(1, pageSize, employeeId), loadPreflight()]);
  }, [employeeId, load, loadPreflight, pageSize]);

  useEffect(() => {
    void load(1, pageSize, employeeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  useEffect(() => {
    void loadPreflight();
  }, [loadPreflight]);

  const confirmAction = useCallback(
    (config: {
      key: string;
      title: string;
      content: string;
      okText: string;
      danger?: boolean;
      run: () => Promise<void>;
    }) => {
      modalApi.confirm({
        title: config.title,
        content: config.content,
        okText: config.okText,
        okButtonProps: { danger: config.danger },
        cancelText: '取消',
        async onOk() {
          setActionLoading(config.key);
          try {
            await config.run();
            await Promise.all([load(1, pageSize, employeeId), loadPreflight()]);
          } catch (error) {
            messageApi.error(errorMessage(error));
          } finally {
            setActionLoading(null);
          }
        },
      });
    },
    [employeeId, load, loadPreflight, messageApi, modalApi, pageSize],
  );

  const runGenerate = () => {
    if (generateDisabledReason) return;
    setGeneratePrecheckFailure(null);
    if (shouldConfirmWarningGenerate(currentPreflight)) {
      const warnings = currentPreflight?.checks.filter((check) => check.severity === 'warning') ?? [];
      modalApi.confirm({
        title: '确认继续生成？',
        content: (
          <Space direction="vertical" size={8}>
            <Typography.Text>当前存在以下 warning，请逐项确认：</Typography.Text>
            <ul style={{ margin: 0, paddingInlineStart: 20 }}>
              {warnings.map((warning) => (
                <li key={warning.code}>
                  <Typography.Text code>{warning.code}</Typography.Text>：{warning.message}
                </li>
              ))}
            </ul>
          </Space>
        ),
        okText: '继续生成',
        cancelText: '取消',
        onOk() {
          setWarningAcknowledgement({ settlementMonth: month, codes: warnings.map((warning) => warning.code) });
          generateForm.setFieldsValue({ attendanceRows: [] });
          setGenerateOpen(true);
        },
      });
      return;
    }

    setWarningAcknowledgement(null);
    generateForm.setFieldsValue({ attendanceRows: [] });
    setGenerateOpen(true);
  };

  const submitGenerate = async () => {
    let values: { attendanceRows?: AttendanceRow[] };
    try {
      values = await generateForm.validateFields();
    } catch {
      messageApi.error('请先修正考勤设置后再生成。');
      return;
    }

    const attendanceByEmployeeId: Record<string, AttendanceStatus> = {};
    for (const row of values.attendanceRows ?? []) {
      const nextEmployeeId = row.employeeId?.trim();
      const nextStatus = row.attendanceStatus;
      if (!nextEmployeeId && !nextStatus) continue;
      if (!nextEmployeeId || !nextStatus) {
        messageApi.error('考勤设置中每一行都必须同时填写员工 ID 和考勤状态。');
        return;
      }
      if (!ATTENDANCE_STATUS_VALUES.has(nextStatus)) {
        messageApi.error('考勤状态只能是 full_attendance / sick_leave / personal_leave / absent / other。');
        return;
      }
      if (attendanceByEmployeeId[nextEmployeeId]) {
        messageApi.error(`员工 ${nextEmployeeId} 的考勤状态重复填写。`);
        return;
      }
      attendanceByEmployeeId[nextEmployeeId] = nextStatus;
    }

    setActionLoading('generate');
    try {
      await apiClient.request(`/settlements/${month}/generate`, {
        method: 'POST',
        body: JSON.stringify(buildSettlementGenerateBody(
          attendanceByEmployeeId,
          warningAcknowledgement,
          month,
          currentPreflight,
        )),
      });
      messageApi.success('工资结算已生成。');
      setGenerateOpen(false);
      setGeneratePrecheckFailure(null);
      setWarningAcknowledgement(null);
      generateForm.resetFields();
      await Promise.all([load(1, pageSize, employeeId), loadPreflight()]);
    } catch (error) {
      const handled = await handleSettlementPrecheckFailure(
        error,
        setGeneratePrecheckFailure,
        loadPreflight,
      );
      if (handled) {
        setWarningAcknowledgement(null);
        if (error instanceof ApiError && error.code === 'SETTLEMENT_WARNING_ACK_REQUIRED') {
          messageApi.error('warning 已变化，请确认刷新后的 warning 后重新提交。');
        }
      } else {
        messageApi.error(errorMessage(error));
      }
    } finally {
      setActionLoading(null);
    }
  };

  const runConfirm = () => {
    confirmAction({
      key: 'confirm',
      title: '确认该月工资结算？',
      content: `确认后 ${month} 的结算状态会从草稿变为已确认。`,
      okText: '确认结算',
      run: async () => {
        await apiClient.request(`/settlements/${month}/confirm`, { method: 'POST' });
        messageApi.success('工资结算已确认。');
      },
    });
  };

  const runLock = () => {
    let reason = '';
    modalApi.confirm({
      title: '确认锁定该结算月份？',
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>锁账后 {month} 将禁止再次生成或修改影响工资结果的数据。</Typography.Text>
          <Input.TextArea rows={3} placeholder="请输入锁账原因" onChange={(event) => (reason = event.target.value)} />
        </Space>
      ),
      okText: '确认锁账',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        setActionLoading('lock');
        try {
          await apiClient.request(`/settlements/${month}/lock`, {
            method: 'POST',
            body: JSON.stringify({ lockReason: reason }),
          });
          messageApi.success('月份已锁账。');
          await Promise.all([load(1, pageSize, employeeId), loadPreflight()]);
        } catch (error) {
          messageApi.error(errorMessage(error));
        } finally {
          setActionLoading(null);
        }
      },
    });
  };

  const runExport = () => {
    confirmAction({
      key: 'export',
      title: '确认导出 CSV？',
      content: `将导出 ${month} 的工资结算明细 CSV。`,
      okText: '确认导出',
      run: async () => {
        const csv = await apiClient.request<string>(`/settlements/${month}/export`);
        downloadCsv(`salary-settlement-${month}.csv`, csv);
        messageApi.success('CSV 已导出。');
      },
    });
  };

  const columns = useMemo<ColumnsType<SettlementDetail>>(
    () => [
      { title: '员工 ID', dataIndex: 'employeeId', key: 'employeeId', fixed: 'left', width: 180 },
      { title: '收入 USD', dataIndex: 'incomeUsd', key: 'incomeUsd', width: 130 },
      { title: '虚拟卡花费 USD', dataIndex: 'cardSpendUsd', key: 'cardSpendUsd', width: 150 },
      { title: '原始毛利 USD', dataIndex: 'grossProfitUsd', key: 'grossProfitUsd', width: 150 },
      {
        title: '分组分配毛利 USD',
        key: 'allocatedProfitUsd',
        width: 170,
        render: (_, record) => displayValue(fieldValue(record, 'allocatedProfitUsd', 'profit')),
      },
      {
        title: '历史负毛利抵扣 USD',
        key: 'historicalNegativeProfitUsd',
        width: 180,
        render: (_, record) => displayValue(fieldValue(record, 'historicalNegativeProfitUsd', 'profit')),
      },
      {
        title: '提成基数 USD',
        key: 'commissionProfitUsd',
        width: 150,
        render: (_, record) => displayValue(fieldValue(record, 'commissionProfitUsd', 'profit')),
      },
      {
        title: '工资档位',
        key: 'salaryMode',
        width: 120,
        render: (_, record) => displayValue(fieldValue(record, 'salaryMode')),
      },
      { title: '提成 RMB', dataIndex: 'commissionRmb', key: 'commissionRmb', width: 130 },
      { title: '全勤奖 RMB', key: 'attendanceBonusRmb', width: 130, render: (_, record) => displayValue(fieldValue(record, 'attendanceBonusRmb', 'salary')) },
      { title: '最终工资 RMB', dataIndex: 'finalSalaryRmb', key: 'finalSalaryRmb', width: 150 },
      {
        title: '操作',
        key: 'action',
        fixed: 'right',
        width: 100,
        render: (_, record) => (
          <Button size="small" onClick={() => setSelectedDetail(record)}>
            明细
          </Button>
        ),
      },
    ],
    [],
  );

  const onTableChange = (pagination: TablePaginationConfig) => {
    const nextPage = pagination.current ?? 1;
    const nextPageSize = pagination.pageSize ?? DEFAULT_PAGE_SIZE;
    void load(nextPage, nextPageSize, employeeId);
  };

  return (
    <section className="page-section settlement-page">
      {messageHolder}
      {modalHolder}
      <div className="data-page-header">
        <div>
          <Typography.Title level={3}>工资结算</Typography.Title>
          <Typography.Text type="secondary">结算月份按 GMT+8 归属，例如 2026-05。</Typography.Text>
        </div>
        <Space wrap>
          <Button onClick={() => void reloadPage()} loading={loading || preflightLoading}>
            刷新
          </Button>
          <Button type="primary" disabled={generateDisabled} loading={actionLoading === 'generate'} onClick={runGenerate}>
            生成
          </Button>
          <Button disabled={!canConfirm || summary?.status !== 'draft'} loading={actionLoading === 'confirm'} onClick={runConfirm}>
            确认结算
          </Button>
          <Button danger disabled={!canLock || summary?.status !== 'confirmed'} loading={actionLoading === 'lock'} onClick={runLock}>
            锁定月份
          </Button>
          <Button disabled={!canExport || !summary} loading={actionLoading === 'export'} onClick={runExport}>
            CSV 导出
          </Button>
        </Space>
      </div>

      {isLocked ? <Alert className="data-page-notice" type="warning" showIcon message="该结算月份已锁账，生成、确认、锁账等修改操作不可执行。" /> : null}
      {loadError ? <Alert className="data-page-notice" type="error" showIcon message={loadError} /> : null}
      {preflightError ? <Alert className="data-page-notice" type="error" showIcon message="preflight 检查失败" description={preflightError} /> : null}
      {generateDisabledReason ? <Alert className="data-page-notice" type="warning" showIcon message="生成工资当前不可用" description={generateDisabledReason} /> : null}

      <Form
        layout="inline"
        className="data-filter"
        onFinish={() => {
          void load(1, pageSize, employeeId);
        }}
      >
        <Form.Item label="结算月份">
          <Input
            type="month"
            value={month}
            onChange={(event) => {
              setWarningAcknowledgement(null);
              setGenerateOpen(false);
              setGeneratePrecheckFailure(null);
              generateForm.resetFields();
              setMonth(event.target.value);
            }}
          />
        </Form.Item>
        <Form.Item label="员工 ID">
          <Input allowClear value={employeeId} placeholder="精确筛选员工 ID" onChange={(event) => setEmployeeId(event.target.value)} />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">
              查询
            </Button>
            <Button
              onClick={() => {
                setEmployeeId('');
                void load(1, pageSize, '');
              }}
            >
              重置员工
            </Button>
          </Space>
        </Form.Item>
      </Form>

      <Descriptions className="settlement-summary" bordered size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
        <Descriptions.Item label="月份">{summary ? formatMonth(summary.settlement.settlementMonth) : month}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={statusColor(summary?.status)}>{statusText(summary?.status)}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="员工数">{summary?.detailCount ?? 0}</Descriptions.Item>
        <Descriptions.Item label="最终工资合计 RMB">{summary?.totalFinalSalaryRmb ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="提成合计 RMB">{summary?.totalCommissionRmb ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="原始毛利合计 USD">{summary?.totalGrossProfitUsd ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="生成时间">{formatDateTime(summary?.settlement.generatedAt)}</Descriptions.Item>
        <Descriptions.Item label="锁账原因">{summary?.settlement.lockReason || '-'}</Descriptions.Item>
      </Descriptions>

      <PreflightPanel
        preflight={currentPreflight}
        loading={preflightLoading}
        disabled={!canViewPreflight}
        onReload={() => void loadPreflight()}
      />

      <Table
        rowKey="employeeId"
        columns={columns}
        dataSource={details}
        loading={loading}
        scroll={{ x: 'max-content' }}
        pagination={{ current: page, pageSize, total, showSizeChanger: true }}
        onChange={onTableChange}
      />

      <Modal
        title="确认生成工资结算"
        open={generateOpen}
        width={760}
        okText="确认生成"
        cancelText="取消"
        confirmLoading={actionLoading === 'generate'}
        okButtonProps={{ disabled: preflightLoading }}
        onOk={() => void submitGenerate()}
        onCancel={() => {
          setGenerateOpen(false);
          setGeneratePrecheckFailure(null);
          setWarningAcknowledgement(null);
          generateForm.resetFields();
        }}
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {generatePrecheckFailure ? (
            <Alert
              type="error"
              showIcon
              message="服务端检查未通过"
              description={generatePrecheckFailure.kind === 'blocking' ? (
                <Space direction="vertical" size={4}>
                  {generatePrecheckFailure.settlementMonth ? (
                    <Typography.Text>结算月份：{generatePrecheckFailure.settlementMonth}</Typography.Text>
                  ) : null}
                  {generatePrecheckFailure.severity ? (
                    <Typography.Text>severity：{generatePrecheckFailure.severity}</Typography.Text>
                  ) : null}
                  {generatePrecheckFailure.blockingChecks.length > 0 ? (
                    <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                      {generatePrecheckFailure.blockingChecks.map((check, index) => (
                        <li key={`${check.code}-${index}`}>
                          <Typography.Text code>{check.code}</Typography.Text>：{check.message}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Typography.Text>服务端未返回可展示的阻断项，请查看刷新后的 preflight 结果。</Typography.Text>
                  )}
                </Space>
              ) : (
                <Space direction="vertical" size={4}>
                  <Typography.Text>服务端当前 warning 与已确认内容不一致，请重新确认。</Typography.Text>
                  <Typography.Text>当前需要确认：{generatePrecheckFailure.requiredWarningCodes.join(', ') || '-'}</Typography.Text>
                  <Typography.Text>缺少：{generatePrecheckFailure.missingWarningCodes.join(', ') || '-'}</Typography.Text>
                  <Typography.Text>未知或已过期：{generatePrecheckFailure.unknownWarningCodes.join(', ') || '-'}</Typography.Text>
                </Space>
              )}
            />
          ) : null}
          <Alert
            type="warning"
            showIcon
            message={`将按 GMT+8 月份 ${month} 重新生成工资结算结果；如果已有草稿结果，明细会被覆盖。本次考勤状态会影响全勤奖。`}
            description="未填写考勤状态的员工会按 full_attendance 计算；只有没有请假的员工才有全勤奖 500，病假可能不扣款但也没有全勤奖。"
          />
          <Form form={generateForm} layout="vertical" preserve={false} initialValues={{ attendanceRows: [] }}>
            <Form.List
              name="attendanceRows"
              rules={[
                {
                  validator: async (_, rows: AttendanceRow[] | undefined) => {
                    const seen = new Set<string>();
                    for (const row of rows ?? []) {
                      const nextEmployeeId = row.employeeId?.trim();
                      if (!nextEmployeeId) continue;
                      if (seen.has(nextEmployeeId)) throw new Error(`员工 ${nextEmployeeId} 的考勤状态重复填写。`);
                      seen.add(nextEmployeeId);
                    }
                  },
                },
              ]}
            >
              {(fields, { add, remove }, { errors }) => (
                <div className="member-list">
                  <div className="member-list-header">
                    <Typography.Text strong>考勤设置</Typography.Text>
                    <Button size="small" onClick={() => add({ employeeId: '', attendanceStatus: 'full_attendance' })}>
                      添加员工
                    </Button>
                  </div>
                  {fields.length === 0 ? (
                    <Typography.Text type="secondary">可只录入非全勤员工；未录入员工默认按 full_attendance 计算。</Typography.Text>
                  ) : null}
                  {fields.map((field) => (
                    <Space key={field.key} className="member-row" align="baseline">
                      <Form.Item
                        {...field}
                        name={[field.name, 'employeeId']}
                        label="员工 ID"
                        rules={[{ required: true, whitespace: true, message: '请填写员工 ID' }]}
                      >
                        <Input placeholder="employeeId" />
                      </Form.Item>
                      <Form.Item
                        {...field}
                        name={[field.name, 'attendanceStatus']}
                        label="考勤状态"
                        rules={[
                          { required: true, message: '请选择考勤状态' },
                          {
                            validator: async (_, value: AttendanceStatus | undefined) => {
                              if (!value || ATTENDANCE_STATUS_VALUES.has(value)) return;
                              throw new Error('考勤状态枚举值不合法。');
                            },
                          },
                        ]}
                      >
                        <Select style={{ width: 180 }} options={ATTENDANCE_STATUS_OPTIONS} />
                      </Form.Item>
                      <Button danger onClick={() => remove(field.name)}>
                        删除
                      </Button>
                    </Space>
                  ))}
                  <Form.ErrorList errors={errors} />
                </div>
              )}
            </Form.List>
          </Form>
        </Space>
      </Modal>

      <Modal
        title={selectedDetail ? `员工工资明细：${selectedDetail.employeeId}` : '员工工资明细'}
        open={Boolean(selectedDetail)}
        footer={null}
        width={860}
        onCancel={() => setSelectedDetail(null)}
        destroyOnClose
      >
        {selectedDetail ? <SettlementDetailView detail={selectedDetail} /> : null}
      </Modal>
    </section>
  );
}

function PreflightPanel({
  preflight,
  loading,
  disabled,
  onReload,
}: {
  preflight: SettlementPreflightResult | null;
  loading: boolean;
  disabled: boolean;
  onReload: () => void;
}) {
  const summaryItems = preflight ? formatPreflightSummary(preflight.summary) : [];
  const columns: ColumnsType<SettlementPreflightCheck> = [
    { title: 'code', dataIndex: 'code', key: 'code', width: 240 },
    {
      title: 'severity',
      dataIndex: 'severity',
      key: 'severity',
      width: 120,
      render: (severity: SettlementPreflightCheck['severity']) => (
        <Tag color={preflightSeverityColor(severity)}>{formatPreflightSeverity(severity)}</Tag>
      ),
    },
    { title: 'message', dataIndex: 'message', key: 'message' },
    { title: 'count', dataIndex: 'count', key: 'count', width: 100, render: displayValue },
    { title: 'amountUsd', dataIndex: 'amountUsd', key: 'amountUsd', width: 140, render: displayValue },
  ];

  return (
    <div className="preflight-panel">
      <div className="member-list-header">
        <Typography.Text strong>preflight 检查</Typography.Text>
        <Button size="small" loading={loading} disabled={disabled} onClick={onReload}>
          重新检查
        </Button>
      </div>
      {disabled ? (
        <Alert type="info" showIcon message="当前用户没有 salary.view_all 权限，不能查看 preflight 检查结果。" />
      ) : preflight ? (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type={preflightAlertType(preflight.severity)}
            showIcon
            message={
              <Space wrap>
                <span>canGenerate: {String(preflight.canGenerate)}</span>
                <span>severity:</span>
                <Tag color={preflightSeverityColor(preflight.severity)}>{formatPreflightSeverity(preflight.severity)}</Tag>
              </Space>
            }
          />
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
            {summaryItems.map((item) => (
              <Descriptions.Item key={item.key} label={item.label}>
                {item.value}
              </Descriptions.Item>
            ))}
          </Descriptions>
          <Table
            rowKey="code"
            size="small"
            columns={columns}
            dataSource={preflight.checks}
            loading={loading}
            pagination={false}
            expandable={{
              expandedRowRender: (record) => (
                <pre className="preflight-details">{formatPreflightDetails(record.details)}</pre>
              ),
              rowExpandable: (record) => Boolean(record.details),
            }}
          />
        </Space>
      ) : (
        <Alert type="info" showIcon message={loading ? 'preflight 检查中...' : '暂无 preflight 检查结果。'} />
      )}
    </div>
  );
}

function SettlementDetailView({ detail }: { detail: SettlementDetail }) {
  return (
    <Descriptions bordered size="small" column={2}>
      <Descriptions.Item label="收入 USD">{detail.incomeUsd}</Descriptions.Item>
      <Descriptions.Item label="虚拟卡花费 USD">{displayValue(fieldValue(detail, 'apiCardSpendUsd', 'cardSpend'))}</Descriptions.Item>
      <Descriptions.Item label="API 卡手续费 USD">{displayValue(fieldValue(detail, 'apiCardFeeUsd', 'cardSpend'))}</Descriptions.Item>
      <Descriptions.Item label="手动卡花费 USD">{displayValue(fieldValue(detail, 'manualCardSpendUsd', 'cardSpend'))}</Descriptions.Item>
      <Descriptions.Item label="手续费后花费 USD">{detail.cardSpendUsd}</Descriptions.Item>
      <Descriptions.Item label="原始毛利 USD">{detail.grossProfitUsd}</Descriptions.Item>
      <Descriptions.Item label="分组 ID">{displayValue(fieldValue(detail, 'groupId', 'profit'))}</Descriptions.Item>
      <Descriptions.Item label="分配比例">{displayValue(fieldValue(detail, 'allocationRatio', 'profit'))}</Descriptions.Item>
      <Descriptions.Item label="分组分配毛利 USD">{displayValue(fieldValue(detail, 'allocatedProfitUsd', 'profit'))}</Descriptions.Item>
      <Descriptions.Item label="历史负毛利抵扣 USD">{displayValue(fieldValue(detail, 'historicalNegativeProfitUsd', 'profit'))}</Descriptions.Item>
      <Descriptions.Item label="提成基数 USD">{displayValue(fieldValue(detail, 'commissionProfitUsd', 'profit'))}</Descriptions.Item>
      <Descriptions.Item label="剩余负毛利 USD">{displayValue(fieldValue(detail, 'remainingNegativeProfitUsd', 'profit'))}</Descriptions.Item>
      <Descriptions.Item label="工资档位">{displayValue(fieldValue(detail, 'salaryMode'))}</Descriptions.Item>
      <Descriptions.Item label="底薪 RMB">{displayValue(fieldValue(detail, 'baseSalaryRmb', 'salary'))}</Descriptions.Item>
      <Descriptions.Item label="星级补贴 RMB">{displayValue(fieldValue(detail, 'starAllowanceRmb', 'salary'))}</Descriptions.Item>
      <Descriptions.Item label="提成比例">{displayValue(fieldValue(detail, 'commissionRate', 'salary'))}</Descriptions.Item>
      <Descriptions.Item label="提成 USD">{displayValue(fieldValue(detail, 'commissionUsd', 'salary'))}</Descriptions.Item>
      <Descriptions.Item label="提成 RMB">{detail.commissionRmb}</Descriptions.Item>
      <Descriptions.Item label="手动加项 RMB">{detail.manualAdditionRmb}</Descriptions.Item>
      <Descriptions.Item label="手动扣项 RMB">{detail.manualDeductionRmb}</Descriptions.Item>
      <Descriptions.Item label="全勤奖 RMB">{displayValue(fieldValue(detail, 'attendanceBonusRmb', 'salary'))}</Descriptions.Item>
      <Descriptions.Item label="考勤状态">{displayValue(detail.attendanceStatus)}</Descriptions.Item>
      <Descriptions.Item label="最终工资 RMB">{detail.finalSalaryRmb}</Descriptions.Item>
    </Descriptions>
  );
}
