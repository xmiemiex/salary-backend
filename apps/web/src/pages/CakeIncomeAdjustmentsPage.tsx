import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';

type AffiliateAccount = {
  id: string;
  platform: string;
  accountCode: string;
  accountName?: string | null;
  status: string;
};

type AdjustmentRow = {
  id: string | null;
  subValue: string;
  employeeCode: string | null;
  employeeName: string | null;
  mappingStatus: 'matched' | 'missing' | 'conflict';
  employeeMismatch: boolean;
  baseRecordPresent: boolean;
  baseRevenueUsd: string;
  adjustmentUsd: string;
  confirmedAdjustmentUsd: string;
  finalRevenueUsd: string;
  previewRevenueUsd: string;
  actualRevenueUsd: string | null;
  reason: string | null;
  status: string | null;
  stale: boolean;
  staleReason: string | null;
  previousBaseRevenueUsd: string | null;
  currentBaseRevenueUsd: string | null;
  importedBy: string | null;
  updatedAt: string | null;
  editable: boolean;
};

type AdjustmentList = {
  account: { id: string; accountCode: string; accountName?: string | null };
  settlementMonth: string;
  providerTimezone: 'cake_system_default';
  settlementTimezone: 'Asia/Shanghai';
  locked: boolean;
  items: AdjustmentRow[];
  summary: {
    baseRevenueUsd: string;
    confirmedAdjustmentUsd: string;
    finalRevenueUsd: string;
    confirmedAdjustmentCount: number;
    draftAdjustmentCount: number;
  };
};

type AdjustmentForm = { actualRevenueUsd: string; reason: string };

function previousCompleteMonth() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return '请求失败，请稍后重试。';
}

function money(value: string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : '-';
}

export function CakeIncomeAdjustmentsPage() {
  const [messageApi, messageHolder] = message.useMessage();
  const [modalApi, modalHolder] = Modal.useModal();
  const [form] = Form.useForm<AdjustmentForm>();
  const watchedTargetRevenue = Form.useWatch('actualRevenueUsd', form);
  const [accounts, setAccounts] = useState<AffiliateAccount[]>([]);
  const [affiliateAccountId, setAffiliateAccountId] = useState<string>();
  const [settlementMonth, setSettlementMonth] = useState(previousCompleteMonth);
  const [payload, setPayload] = useState<AdjustmentList | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<AdjustmentRow | null>(null);
  const livePreview = useMemo(() => {
    if (!editing) return null;
    const base = Number(editing.baseRevenueUsd);
    const target = Number(watchedTargetRevenue);
    if (!Number.isFinite(base) || !Number.isFinite(target) || target < 0) return null;
    return { base, target, adjustment: target - base };
  }, [editing, watchedTargetRevenue]);

  const loadAccounts = useCallback(async () => {
    try {
      const rows = await apiClient.request<AffiliateAccount[]>('/affiliate-accounts?status=active');
      const cakeRows = rows.filter((row) => row.platform.toLowerCase() === 'cake');
      setAccounts(cakeRows);
      setAffiliateAccountId((current) => current ?? cakeRows[0]?.id);
    } catch (error) {
      messageApi.error(errorMessage(error));
    }
  }, [messageApi]);

  const load = useCallback(async () => {
    if (!affiliateAccountId || !settlementMonth) return;
    setLoading(true);
    try {
      const query = new URLSearchParams({ affiliateAccountId, settlementMonth });
      setPayload(await apiClient.request<AdjustmentList>(`/cake-income-adjustments?${query}`));
    } catch (error) {
      setPayload(null);
      messageApi.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [affiliateAccountId, settlementMonth, messageApi]);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);
  useEffect(() => { void load(); }, [load]);

  const openAdjustment = useCallback((row: AdjustmentRow) => {
    setEditing(row);
    form.setFieldsValue({ actualRevenueUsd: row.actualRevenueUsd ?? row.baseRevenueUsd, reason: row.reason ?? '' });
  }, [form]);

  const saveDraft = useCallback(async () => {
    if (!editing || !affiliateAccountId) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      await apiClient.request('/cake-income-adjustments', {
        method: 'POST',
        body: JSON.stringify({ affiliateAccountId, settlementMonth, subValue: editing.subValue, ...values }),
      });
      messageApi.success('调整草稿已保存，尚未计入结算。');
      setEditing(null);
      form.resetFields();
      await load();
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [affiliateAccountId, editing, form, load, messageApi, settlementMonth]);

  const confirmAdjustment = useCallback((row: AdjustmentRow) => {
    if (!row.id) return;
    modalApi.confirm({
      title: `确认 ${row.subValue} 的月度收入调整？`,
      content: `API基础 ${money(row.baseRevenueUsd)} USD，目标 ${money(row.actualRevenueUsd)} USD，调整 ${money(row.adjustmentUsd)} USD。确认后才会计入结算。`,
      okText: '确认计入',
      cancelText: '取消',
      onOk: async () => {
        try {
          await apiClient.request(`/cake-income-adjustments/${encodeURIComponent(row.id as string)}/confirm`, { method: 'PATCH' });
          messageApi.success('调整已确认并计入结算。');
          await load();
        } catch (error) {
          messageApi.error(errorMessage(error));
          throw error;
        }
      },
    });
  }, [load, messageApi, modalApi]);

  const disableAdjustment = useCallback((row: AdjustmentRow) => {
    if (!row.id) return;
    modalApi.confirm({
      title: `停用 ${row.subValue} 的调整？`,
      content: '停用后该调整不再计入工资结算，API基础收入保持不变。',
      okText: '确认停用',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await apiClient.request(`/cake-income-adjustments/${encodeURIComponent(row.id as string)}/disable`, { method: 'PATCH' });
        messageApi.success('调整已停用。');
        await load();
      },
    });
  }, [load, messageApi, modalApi]);

  const exportCsv = useCallback(async () => {
    if (!affiliateAccountId) return;
    try {
      const query = new URLSearchParams({ affiliateAccountId, settlementMonth });
      const result = await apiClient.download(`/cake-income-adjustments/export.csv?${query}`);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `cake-sub-revenue-adjustments-${payload?.account.accountCode ?? 'account'}-${settlementMonth}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      messageApi.error(errorMessage(error));
    }
  }, [affiliateAccountId, messageApi, payload?.account.accountCode, settlementMonth]);

  const columns = useMemo<ColumnsType<AdjustmentRow>>(() => [
    { title: 'SUB ID', dataIndex: 'subValue', fixed: 'left', width: 110 },
    { title: '员工', width: 150, render: (_, row) => row.employeeCode ? `${row.employeeCode} / ${row.employeeName ?? '-'}` : <Tag color="red">未匹配</Tag> },
    { title: 'API默认时区基础 Revenue', width: 175, align: 'right', render: (_, row) => `$${money(row.baseRevenueUsd)}` },
    { title: '调整确认时基础快照', width: 160, align: 'right', render: (_, row) => `$${money(row.previousBaseRevenueUsd ?? row.baseRevenueUsd)}` },
    { title: 'China Standard Time 实际 Revenue', width: 210, align: 'right', render: (_, row) => row.actualRevenueUsd === null ? '-' : `$${money(row.actualRevenueUsd)}` },
    { title: '调整额', width: 120, align: 'right', render: (_, row) => `$${money(row.adjustmentUsd)}` },
    { title: '确认后最终 Revenue', width: 165, align: 'right', render: (_, row) => `$${money(row.previewRevenueUsd)}` },
    { title: '状态', width: 120, render: (_, row) => row.stale ? <Tag color="red">基础已变化</Tag> : row.status === 'confirmed' ? <Tag color="green">已确认</Tag> : row.status === 'draft' ? <Tag color="orange">草稿</Tag> : row.status === 'disabled' ? <Tag>已停用</Tag> : <Tag>无调整</Tag> },
    { title: '原因', dataIndex: 'reason', width: 220, ellipsis: true, render: (value) => value || '-' },
    { title: '操作人', dataIndex: 'importedBy', width: 150, ellipsis: true, render: (value) => value || '-' },
    { title: '更新时间', dataIndex: 'updatedAt', width: 170, render: (value) => value ? value.replace('T', ' ').slice(0, 19) : '-' },
    {
      title: '操作', fixed: 'right', width: 230,
      render: (_, row) => <Space wrap>
        <Button size="small" disabled={!row.editable || row.status === 'confirmed'} onClick={() => openAdjustment(row)}>{row.id ? '编辑草稿' : '新增调整'}</Button>
        <Button size="small" type="primary" disabled={!row.id || row.status !== 'draft'} onClick={() => confirmAdjustment(row)}>确认</Button>
        <Button size="small" danger disabled={!row.id || row.status === 'disabled'} onClick={() => disableAdjustment(row)}>停用</Button>
      </Space>,
    },
  ], [confirmAdjustment, disableAdjustment, openAdjustment]);

  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    {messageHolder}{modalHolder}
    <Typography.Title level={3} style={{ margin: 0 }}>CAKE SUB 月度收入调整</Typography.Title>
    <Alert
      type="info"
      showIcon
      message="API基础收入与CST调整严格分离"
      description="基础收入来自CAKE API系统默认时区，不可在此编辑。管理员录入China Standard Time目标Revenue，系统自动计算有符号差额；草稿不计入结算，确认后才计入。API基础变化时，调整会失效并阻止结算，必须重新确认或停用。"
    />
    {payload?.locked ? <Alert type="error" showIcon message="该月份已锁定，禁止新增、确认或停用调整。" /> : null}
    {payload?.items.some((row) => row.stale) ? <Alert type="error" showIcon message="检测到API基础Revenue变化：相关调整已转为待复核，并将阻止工资结算。" /> : null}
    <Card>
      <Space wrap>
        <Select
          style={{ width: 260 }}
          placeholder="选择CAKE联盟账号"
          value={affiliateAccountId}
          options={accounts.map((row) => ({ value: row.id, label: `${row.accountName ?? row.accountCode} / ${row.accountCode}` }))}
          onChange={setAffiliateAccountId}
        />
        <Input type="month" style={{ width: 150 }} value={settlementMonth} onChange={(event) => setSettlementMonth(event.target.value)} />
        <Button loading={loading} onClick={() => void load()}>刷新基础记录显示</Button>
        <Button onClick={() => void exportCsv()} disabled={!payload}>导出核对CSV</Button>
      </Space>
    </Card>
    {payload ? <Space wrap size={24}>
      <Statistic title="API基础Revenue" prefix="$" value={payload.summary.baseRevenueUsd} precision={2} />
      <Statistic title="已确认调整" prefix="$" value={payload.summary.confirmedAdjustmentUsd} precision={2} />
      <Statistic title="结算Revenue" prefix="$" value={payload.summary.finalRevenueUsd} precision={2} />
      <Statistic title="草稿调整数" value={payload.summary.draftAdjustmentCount} />
    </Space> : null}
    <Table rowKey={(row) => row.subValue} loading={loading} dataSource={payload?.items ?? []} columns={columns} scroll={{ x: 1960 }} pagination={false} />
    <Modal
      title={editing ? `${editing.subValue} / ${editing.employeeCode ?? '-'} 月度Revenue调整` : '月度Revenue调整'}
      open={Boolean(editing)}
      okText="保存草稿"
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => void saveDraft()}
      onCancel={() => { setEditing(null); form.resetFields(); }}
      destroyOnClose
    >
      {editing ? <Alert
        style={{ marginBottom: 16 }}
        type="warning"
        showIcon
        message={livePreview
          ? `API基础 $${money(String(livePreview.base))}；CST目标 $${money(String(livePreview.target))}；自动调整 ${livePreview.adjustment >= 0 ? '+' : ''}$${money(String(livePreview.adjustment))}；最终 $${money(String(livePreview.target))}`
          : `API默认时区基础：$${money(editing.baseRevenueUsd)}；请输入同月China Standard Time实际Revenue。`}
      /> : null}
      <Form form={form} layout="vertical">
        <Form.Item name="actualRevenueUsd" label="China Standard Time 实际 Revenue (USD)" rules={[{ required: true, message: '请输入实际Revenue' }, { pattern: /^\d+(?:\.\d{1,6})?$/, message: '请输入非负金额，最多6位小数' }]}>
          <Input inputMode="decimal" placeholder="例如 77710" />
        </Form.Item>
        <Form.Item name="reason" label="调整原因" rules={[{ required: true, whitespace: true, message: '必须填写调整原因' }, { max: 1000, message: '最多1000个字符' }]}>
          <Input.TextArea rows={4} placeholder="说明Portal China Standard Time报表与API默认时区基础的差异依据" />
        </Form.Item>
      </Form>
    </Modal>
  </Space>;
}
