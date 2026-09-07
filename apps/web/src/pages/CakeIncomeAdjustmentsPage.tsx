import {
  Alert,
  Button,
  Card,
  Checkbox,
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import { cakePageTotals, exactUsd, sumUsd, usdUnits, unitsToUsd } from './cake-adjustment-totals';

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
  return exactUsd(value);
}

export function CakeIncomeAdjustmentsPage() {
  const [messageApi, messageHolder] = message.useMessage();
  const [modalApi, modalHolder] = Modal.useModal();
  const [form] = Form.useForm<AdjustmentForm>();
  const watchedTargetRevenue = Form.useWatch('actualRevenueUsd', form);
  const [accounts, setAccounts] = useState<AffiliateAccount[]>([]);
  const [affiliateAccountId, setAffiliateAccountId] = useState<string | undefined>(() => new URLSearchParams(window.location.search).get('affiliateAccountId') || undefined);
  const [settlementMonth, setSettlementMonth] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get('settlementMonth');
    return requested && /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) ? requested : previousCompleteMonth();
  });
  const [payload, setPayload] = useState<AdjustmentList | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<AdjustmentRow | null>(null);
  const [selected, setSelected] = useState<AdjustmentRow[]>([]);
  const [page, setPage] = useState(1), [batchOpen, setBatchOpen] = useState(false);
  const requestSequence = useRef(0), currentScope = useRef('');
  currentScope.current = `${affiliateAccountId}|${settlementMonth}`;
  const displayed = payload && payload.account.id === affiliateAccountId && payload.settlementMonth === settlementMonth ? payload.items : [];
  const currentPage = displayed.slice((page - 1) * 20, page * 20);
  const selectable = (row: AdjustmentRow) => !!row.id && !payload?.locked && ['draft', 'confirmed'].includes(row.status ?? '');
  const confirmable = (row: AdjustmentRow) => selectable(row) && row.status === 'draft' && row.editable && !row.stale;
  const currentSelectable = currentPage.filter(selectable);
  const livePreview = useMemo(() => {
    if (!editing) return null;
    if (typeof watchedTargetRevenue !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(watchedTargetRevenue)) return null;
    const base = editing.baseRevenueUsd, target = watchedTargetRevenue;
    return { base, target, adjustment: unitsToUsd(usdUnits(target) - usdUnits(base)) };
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
    const sequence = ++requestSequence.current, scope = `${affiliateAccountId}|${settlementMonth}`;
    setLoading(true);
    try {
      const query = new URLSearchParams({ affiliateAccountId, settlementMonth });
      const next = await apiClient.request<AdjustmentList>(`/cake-income-adjustments?${query}`);
      if (sequence !== requestSequence.current || scope !== currentScope.current) return;
      setPayload(next);
      setSelected(previous => previous.filter(row => !next.locked && next.items.some(item => item.id === row.id && item.updatedAt === row.updatedAt && ['draft', 'confirmed'].includes(item.status ?? ''))));
      setPage(previous => Math.min(previous, Math.max(1, Math.ceil(next.items.length / 20))));
    } catch (error) {
      if (sequence !== requestSequence.current || scope !== currentScope.current) return;
      setPayload(null);
      setSelected([]);
      messageApi.error(errorMessage(error));
    } finally {
      if (sequence === requestSequence.current && scope === currentScope.current) setLoading(false);
    }
  }, [affiliateAccountId, settlementMonth, messageApi]);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSelected([]); setPage(1); setEditing(null); }, [affiliateAccountId, settlementMonth]);

  const batch = (operation: 'confirm' | 'disable') => {
    if (editing) { messageApi.warning('请先保存正在编辑的草稿。'); return; }
    if (!selected.length || selected.some(row => operation === 'confirm' ? !confirmable(row) : !selectable(row))) {
      messageApi.warning(operation === 'confirm' ? '确认仅支持基准有效的草稿，请检查所选状态。' : '停用仅支持草稿或已确认记录。'); return;
    }
    const requestId = crypto.randomUUID();
    const body = { affiliateAccountId, settlementMonth, requestId, items: selected.map(row => ({ id: row.id, updatedAt: row.updatedAt })) };
    setBatchOpen(true);
    let inFlight = false;
    const dialog = modalApi.confirm({
      title: `${operation === 'confirm' ? '确认' : '停用'}所选 ${selected.length} 条调整？`,
      content: `${payload?.account.accountName ?? payload?.account.accountCode} / ${settlementMonth}；SUB：${selected.map(row => row.subValue).join('、')}；所选调整额合计 $${money(sumUsd(selected.map(row => row.adjustmentUsd)))}。整批成功或整批不处理，${operation === 'confirm' ? '确认后计入结算' : '停用后不再计入结算'}。`,
      okText: operation === 'confirm' ? '确认计入所选' : '确认停用所选', cancelText: '返回', okButtonProps: { danger: operation === 'disable' },
      onCancel: () => setBatchOpen(false),
      onOk: (close: () => void) => {
        if (inFlight) return;
        inFlight = true;
        dialog.update({ okButtonProps: { loading: true, danger: operation === 'disable' }, cancelButtonProps: { disabled: true } });
        void (async () => {
        setSaving(true);
        try {
          await apiClient.request(`/cake-income-adjustments/batch/${operation}`, { method: 'POST', body: JSON.stringify(body) });
          setSelected([]); setBatchOpen(false);
          close();
          messageApi.success(operation === 'confirm' ? '所选调整已全部确认。' : '所选调整已全部停用。');
          await load();
        } catch (error) { messageApi.error(errorMessage(error)); }
        finally { setSaving(false); inFlight = false; dialog.update({ okButtonProps: { loading: false, danger: operation === 'disable' }, cancelButtonProps: { disabled: false } }); }
        })();
      },
    });
  };

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
    { title: '确认后最终 Revenue（预览）', width: 185, align: 'right', render: (_, row) => `$${money(row.previewRevenueUsd)}` },
    { title: '状态', width: 120, render: (_, row) => row.stale ? <Tag color="red">基础已变化</Tag> : row.status === 'confirmed' ? <Tag color="green">已确认</Tag> : row.status === 'draft' ? <Tag color="orange">草稿</Tag> : row.status === 'disabled' ? <Tag>已停用</Tag> : <Tag>无调整</Tag> },
    { title: '原因', dataIndex: 'reason', width: 220, ellipsis: true, render: (value) => value || '-' },
    { title: '操作人', dataIndex: 'importedBy', width: 150, ellipsis: true, render: (value) => value || '-' },
    { title: '更新时间', dataIndex: 'updatedAt', width: 170, render: (value) => value ? value.replace('T', ' ').slice(0, 19) : '-' },
    {
      title: '操作', fixed: 'right', width: 230,
      render: (_, row) => <Space wrap>
        <Button size="small" disabled={!row.editable || row.status === 'confirmed'} onClick={() => openAdjustment(row)}>{row.id ? '编辑草稿' : '新增调整'}</Button>
        <Button size="small" type="primary" disabled={loading || saving || payload?.locked || !row.id || row.status !== 'draft'} onClick={() => confirmAdjustment(row)}>确认</Button>
        <Button size="small" danger disabled={loading || saving || payload?.locked || !row.id || row.status === 'disabled'} onClick={() => disableAdjustment(row)}>停用</Button>
      </Space>,
    },
  ], [confirmAdjustment, disableAdjustment, openAdjustment, payload?.locked, loading, saving]);

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
          aria-label="CAKE联盟账号"
          disabled={saving || batchOpen || !!editing}
          value={affiliateAccountId}
          options={accounts.map((row) => ({ value: row.id, label: `${row.accountName ?? row.accountCode} / ${row.accountCode}` }))}
          onChange={setAffiliateAccountId}
        />
        <Input aria-label="调整月份" type="month" style={{ width: 150 }} disabled={saving || batchOpen || !!editing} value={settlementMonth} onChange={(event) => setSettlementMonth(event.target.value)} />
        <Button loading={loading} disabled={saving || batchOpen || !!editing} onClick={() => void load()}>刷新基础记录显示</Button>
        <Button onClick={() => void exportCsv()} disabled={!payload}>导出核对CSV</Button>
      </Space>
    </Card>
    {payload ? <Space wrap size={24}>
      <Statistic title="API基础Revenue" prefix="$" value={payload.summary.baseRevenueUsd} precision={2} />
      <Statistic title="已确认调整" prefix="$" value={payload.summary.confirmedAdjustmentUsd} precision={2} />
      <Statistic title="结算Revenue" prefix="$" value={payload.summary.finalRevenueUsd} precision={2} />
      <Statistic title="草稿调整数" value={payload.summary.draftAdjustmentCount} />
    </Space> : null}
    <Space wrap>
      <span>已选 {selected.length} 条</span>
      <Button type="primary" disabled={loading || saving || batchOpen || !!editing || !selected.length || !selected.every(confirmable)} onClick={() => batch('confirm')}>确认所选</Button>
      <Button danger disabled={loading || saving || batchOpen || !!editing || !selected.length || !selected.every(selectable)} onClick={() => batch('disable')}>停用所选</Button>
      <Typography.Text type="secondary">确认仅支持有效草稿；停用支持草稿和已确认记录。换页或切换账号、月份后清除选择。</Typography.Text>
    </Space>
    <Table<AdjustmentRow> rowKey="subValue" loading={loading} dataSource={displayed} columns={columns} scroll={{ x: 2060 }}
      pagination={{ current: page, pageSize: 20, showSizeChanger: false, onChange: next => { setPage(next); setSelected([]); } }}
      rowSelection={{ fixed: true, columnWidth: 48, selectedRowKeys: selected.map(row => row.subValue),
        columnTitle: <Checkbox aria-label="全选当前页" disabled={loading || saving || !currentSelectable.length} checked={!!currentSelectable.length && currentSelectable.every(row => selected.some(s => s.id === row.id))} indeterminate={selected.length > 0 && !currentSelectable.every(row => selected.some(s => s.id === row.id))} onChange={event => setSelected(event.target.checked ? currentSelectable : [])} />,
        onChange: (_, rows) => setSelected(rows.filter(row => currentPage.some(item => item.id === row.id))),
        getCheckboxProps: row => ({ disabled: loading || saving || !selectable(row), 'aria-label': `选择 ${row.subValue}` }),
      }}
      summary={rows => <Table.Summary><Table.Summary.Row><Table.Summary.Cell index={0} colSpan={2}><strong>当前页合计</strong></Table.Summary.Cell><Table.Summary.Cell index={2} />{cakePageTotals([...rows]).map((value, index) => <Table.Summary.Cell key={index} index={index + 3} align="right"><strong>{value == null ? '—' : `$${money(value)}`}</strong></Table.Summary.Cell>)}<Table.Summary.Cell index={8} colSpan={4} /><Table.Summary.Cell index={12} /></Table.Summary.Row></Table.Summary>}
    />
    <span style={{ color: '#64748b' }}>当前页目标空值不计入合计；预览合计包含草稿，不代表已确认收入。</span>
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
          ? `API基础 $${money(livePreview.base)}；CST目标 $${money(livePreview.target)}；自动调整 ${livePreview.adjustment.startsWith('-') ? '' : '+'}$${money(livePreview.adjustment)}；最终 $${money(livePreview.target)}`
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
