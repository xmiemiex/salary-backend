import { Alert, Button, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import { getStoredActor } from '../lib/auth-storage';
import { PhotonPayCardGovernancePanel } from './PhotonPayCardGovernancePanel';

type CommonStatus = 'active' | 'disabled' | 'draft' | 'confirmed' | 'locked';
type FieldType = 'text' | 'date' | 'month' | 'select' | 'textarea' | 'json';
type ActionType = 'confirm' | 'disable' | 'returnToDraft';
type OptionSource = 'affiliateAccounts' | 'employees';

type BaseRecord = {
  id: string;
  status?: CommonStatus;
  createdAt?: string;
  updatedAt?: string;
  members?: PerformanceGroupMember[];
  group?: BaseRecord;
  config?: { code?: string; name?: string; itemType?: string };
  [key: string]: unknown;
};

type PerformanceGroupMember = {
  employeeId: string;
  allocationRatio: string;
};

type FieldConfig = {
  name: string;
  label: string;
  type?: FieldType;
  required?: boolean;
  options?: { label: string; value: string }[];
  optionSource?: OptionSource;
  clearOnEmpty?: boolean;
  placeholder?: string;
  help?: string;
  list?: boolean;
  filter?: boolean;
  create?: boolean;
  edit?: boolean;
  render?: (record: BaseRecord) => string;
};

type PageConfig = {
  title: string;
  endpoint: string;
  fields: FieldConfig[];
  actions?: ActionType[];
  defaultCreateValues?: Record<string, unknown>;
  notice?: string;
  customForm?: 'performanceGroup';
  normalizeRecord?: (record: BaseRecord) => BaseRecord;
};

const STATUS_OPTIONS = [
  { label: '启用', value: 'active' },
  { label: '禁用', value: 'disabled' },
];

const DRAFT_CONFIRM_STATUS_OPTIONS = [
  { label: '草稿', value: 'draft' },
  { label: '已确认', value: 'confirmed' },
];

const ALL_MANUAL_STATUS_OPTIONS = [
  { label: '启用', value: 'active' },
  { label: '已确认', value: 'confirmed' },
  { label: '禁用', value: 'disabled' },
];

const SALARY_ITEM_TYPE_OPTIONS = [
  { label: '加项', value: 'addition' },
  { label: '扣项', value: 'deduction' },
];

const PROVIDER_OPTIONS = [
  { label: 'Airwallex', value: 'airwallex' },
  { label: 'PhotonPay', value: 'photonpay' },
];

export const AFFILIATE_PLATFORM_OPTIONS = [
  { label: 'CAKE', value: 'cake' },
  { label: 'Everflow', value: 'everflow' },
];

const PAGE_CONFIGS: Record<string, PageConfig> = {
  '/employees': {
    title: '员工管理',
    endpoint: '/employees',
    defaultCreateValues: { status: 'active' },
    fields: [
      { name: 'employeeCode', label: '员工编码', required: true, filter: false },
      { name: 'name', label: '姓名', required: true },
      { name: 'email', label: '邮箱', clearOnEmpty: true },
      { name: 'phone', label: '手机号' },
      { name: 'hiredAt', label: '入职日期', type: 'date' },
      { name: 'leftAt', label: '离职日期', type: 'date' },
      { name: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS, filter: true },
    ],
  },
  '/affiliate-accounts': {
    title: '联盟账号',
    endpoint: '/affiliate-accounts',
    defaultCreateValues: { platform: 'cake', status: 'active' },
    fields: [
      { name: 'platform', label: '平台', type: 'select', options: AFFILIATE_PLATFORM_OPTIONS, required: true },
      { name: 'accountCode', label: 'Affiliate ID/账号编码', required: true },
      { name: 'accountName', label: '联盟账号名称' },
      { name: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS, filter: true },
    ],
  },
  '/sub-id-mappings': {
    title: 'SUB ID 映射',
    endpoint: '/sub-id-mappings',
    notice: '映射从生效月份开始持续有效，后续月份无需重复创建；只有归属变化时才新增更晚月份的映射版本。',
    defaultCreateValues: { status: 'active' },
    fields: [
      { name: 'affiliateAccountId', label: '联盟账号', type: 'select', optionSource: 'affiliateAccounts', required: true },
      { name: 'subField', label: 'SUB 字段', type: 'select', options: ['sub1', 'sub2', 'sub3', 'sub4', 'sub5'].map((value) => ({ label: value, value })), required: true },
      { name: 'subValue', label: 'SUB 值', required: true },
      { name: 'effectiveMonth', label: '生效月份（从本月起）', type: 'month', required: true, filter: true },
      { name: 'employeeId', label: '员工', type: 'select', optionSource: 'employees', required: true, filter: true },
      { name: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS, filter: true },
    ],
  },
  '/card-bindings': {
    title: '虚拟卡自动关联',
    endpoint: '/card-bindings',
    notice: '卡片由服务商接口全量发现，并按持卡人邮箱精确关联员工；此页面不提供手工绑卡入口。',
    fields: [],
  },
  '/monthly-exchange-rates': {
    title: '汇率设置',
    endpoint: '/monthly-exchange-rates',
    defaultCreateValues: { status: 'active' },
    fields: [
      { name: 'settlementMonth', label: '结算月份', type: 'month', required: true, filter: true },
      { name: 'usdToRmbRate', label: 'USD/CNY 汇率', required: true, placeholder: '例如 7.25000000' },
      { name: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS, filter: true },
    ],
  },
  '/card-provider-fee-rates': {
    title: '虚拟卡手续费',
    endpoint: '/monthly-card-provider-fee-rates',
    defaultCreateValues: { status: 'active' },
    fields: [
      { name: 'settlementMonth', label: '结算月份', type: 'month', required: true, filter: true },
      { name: 'provider', label: '卡服务商', type: 'select', options: PROVIDER_OPTIONS, required: true, filter: true },
      { name: 'feeRate', label: '手续费率', required: true, placeholder: '例如 0.018' },
      { name: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS, filter: true },
    ],
  },
  '/manual-income-records': {
    title: '手动收入',
    endpoint: '/manual-income-records',
    actions: ['confirm', 'disable'],
    defaultCreateValues: { status: 'draft' },
    notice: '只有已确认的手动收入会进入工资结算；确认时必须能关联 employeeId，最终以后端校验为准。',
    fields: [
      { name: 'settlementMonth', label: '结算月份', type: 'month', required: true, filter: true },
      { name: 'source', label: '来源', required: true, filter: false },
      { name: 'incomeUsd', label: '收入 USD', required: true, placeholder: '字符串金额，例如 123.45' },
      { name: 'employeeId', label: '员工 ID', filter: true },
      { name: 'affiliateAccountId', label: '联盟账号 ID' },
      { name: 'subField', label: 'SUB 字段' },
      { name: 'subValue', label: 'SUB 值' },
      { name: 'externalRecordId', label: '外部记录 ID' },
      { name: 'rawData', label: '原始数据 JSON', type: 'json', list: false, placeholder: '{"key":"value"}' },
      { name: 'status', label: '状态', type: 'select', options: DRAFT_CONFIRM_STATUS_OPTIONS, filter: true, create: false, edit: false },
    ],
  },
  '/manual-card-spend': {
    title: '手动卡花费',
    endpoint: '/manual-card-spend-entries',
    actions: ['confirm', 'returnToDraft'],
    defaultCreateValues: { status: 'draft' },
    notice: 'actualSpendUsd 由后端按 settledSpendUsd 和 feeRate 计算；如填写该字段，后端会校验是否等于计算值。',
    fields: [
      { name: 'settlementMonth', label: '结算月份', type: 'month', required: true, filter: true },
      { name: 'employeeId', label: '员工 ID', required: true, filter: true },
      { name: 'providerName', label: '平台名称', required: true, placeholder: '自由文本' },
      { name: 'cardIdentifier', label: '卡标识' },
      { name: 'settledSpendUsd', label: '结算花费 USD', required: true, placeholder: '字符串金额，例如 100.00' },
      { name: 'feeRate', label: '手续费率', required: true, placeholder: '字符串比例，例如 0.018' },
      { name: 'actualSpendUsd', label: '实际花费 USD', placeholder: '可留空，由后端计算' },
      { name: 'reason', label: '原因', type: 'textarea', list: false },
      { name: 'status', label: '状态', type: 'select', options: DRAFT_CONFIRM_STATUS_OPTIONS, filter: true, create: false, edit: false },
    ],
  },
  '/historical-negative-profits': {
    title: '历史负毛利',
    endpoint: '/historical-negative-profits',
    actions: ['disable'],
    defaultCreateValues: { status: 'active' },
    notice: 'amountUsd 请填写正数 USD，表示需要滚动抵扣的负毛利债；不涉及 RMB。',
    fields: [
      { name: 'settlementMonth', label: '结算月份', type: 'month', required: true, filter: true },
      { name: 'employeeId', label: '员工 ID', required: true, filter: true },
      { name: 'amountUsd', label: '待抵扣金额 USD（正数）', required: true, placeholder: '填写正数 USD，例如 250.00' },
      { name: 'reason', label: '原因', type: 'textarea', list: false },
      { name: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS, filter: true },
    ],
  },
  '/performance-groups': {
    title: '业绩分组',
    endpoint: '/performance-groups',
    actions: ['disable'],
    customForm: 'performanceGroup',
    defaultCreateValues: { status: 'active', salaryMode: 'group', members: [{ employeeId: '', allocationRatio: '' }] },
    fields: [
      { name: 'settlementMonth', label: '结算月份', type: 'month', required: true, filter: true },
      { name: 'name', label: '分组名称', required: true },
      { name: 'salaryMode', label: '工资模式', list: false, create: false, edit: false },
      { name: 'members', label: '成员', create: false, edit: false, render: renderMembers },
      { name: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS, filter: true },
    ],
  },
  '/salary-item-configs': {
    title: '工资手动项配置',
    endpoint: '/salary-item-configs',
    actions: ['disable'],
    defaultCreateValues: { status: 'active' },
    fields: [
      { name: 'code', label: '编码', required: true },
      { name: 'name', label: '名称', required: true },
      { name: 'itemType', label: '类型', type: 'select', options: SALARY_ITEM_TYPE_OPTIONS, required: true, filter: false },
      { name: 'description', label: '描述', type: 'textarea', list: false },
      { name: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS, filter: true },
    ],
  },
  '/salary-manual-items': {
    title: '月度工资手动项',
    endpoint: '/monthly-salary-manual-items',
    actions: ['disable'],
    defaultCreateValues: { status: 'active' },
    fields: [
      { name: 'settlementMonth', label: '结算月份', type: 'month', required: true, filter: true },
      { name: 'employeeId', label: '员工 ID', required: true, filter: true },
      { name: 'configId', label: '配置 ID', required: true },
      { name: 'configName', label: '配置名称', create: false, edit: false, render: (record) => formatConfig(record) },
      { name: 'amountRmb', label: '金额 RMB', required: true, placeholder: '字符串金额，例如 800.00' },
      { name: 'remark', label: '备注', type: 'textarea', list: false },
      { name: 'status', label: '状态', type: 'select', options: ALL_MANUAL_STATUS_OPTIONS, filter: true },
    ],
  },
};

function formatDate(value: unknown): string {
  return typeof value === 'string' && value ? value.slice(0, 10) : '';
}

function formatMonth(value: unknown): string {
  return typeof value === 'string' && value ? value.slice(0, 7) : '';
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function formatConfig(record: BaseRecord): string {
  if (!record.config) return '';
  const name = record.config.name ?? '';
  const code = record.config.code ? `（${record.config.code}）` : '';
  return `${name}${code}`;
}

function renderMembers(record: BaseRecord): string {
  const members = Array.isArray(record.members) ? record.members : [];
  return members.map((member) => `${member.employeeId}: ${member.allocationRatio}`).join('；');
}

function normalizeRecords(payload: unknown): BaseRecord[] {
  if (!Array.isArray(payload)) return [];
  return payload.map((item) => {
    const record = item as BaseRecord;
    if (record.group && typeof record.group === 'object') {
      return { ...record.group, members: record.members };
    }
    return record;
  });
}

function normalizeForForm(record: BaseRecord, fields: FieldConfig[], customForm?: PageConfig['customForm']) {
  const result: Record<string, unknown> = {};
  fields.forEach((field) => {
    const value = record[field.name];
    if (field.type === 'month') result[field.name] = formatMonth(value);
    else if (field.type === 'date') result[field.name] = formatDate(value);
    else if (field.type === 'json' && value !== undefined && value !== null) result[field.name] = JSON.stringify(value, null, 2);
    else result[field.name] = value ?? undefined;
  });
  if (customForm === 'performanceGroup') {
    result.members = Array.isArray(record.members)
      ? record.members.map((member) => ({
          employeeId: member.employeeId,
          allocationRatio: formatValue(member.allocationRatio),
        }))
      : [{ employeeId: '', allocationRatio: '' }];
    result.salaryMode = 'group';
  }
  return result;
}

export function normalizePayload(values: Record<string, unknown>, fields: FieldConfig[], includeCleared = false) {
  const result: Record<string, unknown> = {};
  fields.forEach((field) => {
    const value = values[field.name];
    if (value === undefined || value === null) return;
    if (value === '') {
      if (includeCleared && field.clearOnEmpty) result[field.name] = '';
      return;
    }
    if (field.type === 'month') {
      result[field.name] = `${String(value)}-01`;
      return;
    }
    if (field.type === 'json') {
      result[field.name] = typeof value === 'string' ? JSON.parse(value) : value;
      return;
    }
    result[field.name] = value;
  });
  return result;
}

function normalizePerformanceGroupPayload(values: Record<string, unknown>, fields: FieldConfig[]) {
  const payload = normalizePayload(values, fields);
  const members = Array.isArray(values.members) ? (values.members as PerformanceGroupMember[]) : [];
  payload.members = members
    .filter((member) => member && (member.employeeId || member.allocationRatio))
    .map((member) => ({
      employeeId: member.employeeId,
      allocationRatio: member.allocationRatio,
    }));
  payload.salaryMode = 'group';
  return payload;
}

function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return 'JSON 格式不正确，请检查后再提交。';
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试。';
}

function statusColor(value: unknown): string {
  if (value === 'active' || value === 'confirmed') return 'green';
  if (value === 'draft') return 'blue';
  if (value === 'disabled') return 'default';
  if (value === 'locked') return 'red';
  return 'default';
}

function statusText(value: unknown): string {
  const map: Record<string, string> = {
    active: '启用',
    disabled: '禁用',
    draft: '草稿',
    confirmed: '已确认',
    locked: '已锁定',
  };
  return typeof value === 'string' ? map[value] ?? value : '';
}

type FieldControlProps = {
  field: FieldConfig;
  onValueChange?: () => void;
  id?: string;
  value?: string | number | bigint | readonly string[];
  onChange?: (...args: unknown[]) => void;
  disabled?: boolean;
};

function FieldControl({ field, onValueChange, onChange, ...formControlProps }: FieldControlProps) {
  const handleChange = (...args: unknown[]) => {
    onChange?.(...args);
    onValueChange?.();
  };
  if (field.type === 'select') {
    return (
      <Select
        {...formControlProps}
        onChange={handleChange}
        allowClear
        options={field.options ?? []}
        placeholder={field.placeholder ?? `请选择${field.label}`}
      />
    );
  }
  if (field.type === 'textarea' || field.type === 'json') {
    return (
      <Input.TextArea
        {...formControlProps}
        onInput={handleChange}
        rows={field.type === 'json' ? 5 : 3}
        placeholder={field.placeholder ?? `请输入${field.label}`}
      />
    );
  }
  return (
    <Input
      {...formControlProps}
      onInput={handleChange}
      type={field.type === 'date' || field.type === 'month' ? field.type : 'text'}
      placeholder={field.placeholder ?? `请输入${field.label}`}
    />
  );
}

export function buildAffiliateAccountOptions(accounts: BaseRecord[]) {
  return accounts.map((account) => ({
    value: account.id,
    label: `${String(account.platform ?? '').toUpperCase()} / ${String(account.accountName ?? account.accountCode ?? '')} / ${String(account.accountCode ?? '')}`,
  }));
}

export function buildEmployeeOptions(employees: BaseRecord[]) {
  return employees.map((employee) => ({
    value: employee.id,
    label: `${String(employee.employeeCode ?? '')} / ${String(employee.name ?? '')}${employee.status === 'disabled' ? '（已禁用）' : ''}`,
  }));
}

function PerformanceGroupMembersForm() {
  return (
    <Form.List
      name="members"
      rules={[
        {
          validator: async (_, value: PerformanceGroupMember[] | undefined) => {
            if (!value || value.length === 0) throw new Error('请至少添加一个成员');
            const complete = value.filter((member) => member?.employeeId && member?.allocationRatio);
            if (complete.length !== value.length) throw new Error('成员 employeeId 和 allocationRatio 都必须填写');
          },
        },
      ]}
    >
      {(fields, { add, remove }, { errors }) => (
        <div className="member-list">
          <div className="member-list-header">
            <Typography.Text strong>分组成员</Typography.Text>
            <Button size="small" onClick={() => add({ employeeId: '', allocationRatio: '' })}>
              添加成员
            </Button>
          </div>
          {fields.map((field) => (
            <Space key={field.key} className="member-row" align="baseline">
              <Form.Item
                {...field}
                name={[field.name, 'employeeId']}
                label="员工 ID"
                rules={[{ required: true, message: '请填写员工 ID' }]}
              >
                <Input placeholder="employeeId" />
              </Form.Item>
              <Form.Item
                {...field}
                name={[field.name, 'allocationRatio']}
                label="分配比例"
                rules={[{ required: true, message: '请填写分配比例' }]}
              >
                <Input placeholder="例如 0.5" />
              </Form.Item>
              <Button danger disabled={fields.length <= 1} onClick={() => remove(field.name)}>
                删除
              </Button>
            </Space>
          ))}
          <Typography.Text type="secondary">比例请按字符串填写，例如 0.5、0.1、0.9；合计必须为 1，最终以后端校验为准。</Typography.Text>
          <Form.ErrorList errors={errors} />
        </div>
      )}
    </Form.List>
  );
}

export function hasBaseDataPage(path: string): boolean {
  return Boolean(PAGE_CONFIGS[path]);
}

export function BaseDataPage({ path }: { path: string }) {
  if (path === '/card-bindings') return <ProviderCardsPage />;
  return <GenericBaseDataPage path={path} />;
}

type ProviderCardRow = BaseRecord & {
  provider: 'airwallex' | 'photonpay';
  cardId: string;
  maskedCardNumber?: string | null;
  nickname?: string | null;
  providerStatus?: string | null;
  cardholderEmail?: string | null;
  employeeCode?: string | null;
  employeeName?: string | null;
  matchStatus: 'matched' | 'unmatched' | 'conflict' | 'excluded';
  matchSource?: 'employee_primary_email' | 'provider_email_alias' | null;
  unmatchedReasonCode?: string | null;
  lastCardSyncedAt?: string | null;
  lastTransactionSyncedAt?: string | null;
  lastTransactionSyncStatus?: string | null;
};

type ProviderCardListResponse = { items: ProviderCardRow[]; summary: Record<string, number> };
type ProviderSyncResult = {
  provider: 'airwallex' | 'photonpay';
  status: 'completed' | 'partial' | 'external_blocked' | 'failed';
  discoveredCount: number;
  matchedCount: number;
  unmatchedCount: number;
  conflictCount: number;
  invalidCardCount?: number;
  apiVersion?: string;
  error?: { category?: string; httpStatus?: number | null; code?: string | null; message?: string; requestId?: string | null; apiVersion?: string | null };
};

function ProviderCardsPage() {
  const canSync = getStoredActor()?.permissions.includes('card_binding.manage') ?? false;
  const [messageApi, messageHolder] = message.useMessage();
  const [rows, setRows] = useState<ProviderCardRow[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [results, setResults] = useState<ProviderSyncResult[]>([]);

  const loadCards = useCallback(async (nextFilters = filters) => {
    setLoading(true);
    try {
      const query = new URLSearchParams(Object.entries(nextFilters).filter(([, value]) => Boolean(value))).toString();
      const response = await apiClient.request<ProviderCardListResponse>(`/card-bindings${query ? `?${query}` : ''}`);
      setRows(response.items);
      setSummary(response.summary);
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [filters, messageApi]);

  useEffect(() => { void loadCards({}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const syncCards = async (provider?: 'airwallex' | 'photonpay') => {
    setSyncing(provider ?? 'all');
    try {
      const response = provider
        ? await apiClient.request<ProviderSyncResult>(`/card-bindings/sync/${provider}`, { method: 'POST' })
        : await apiClient.request<{ results: ProviderSyncResult[] }>('/card-bindings/sync', { method: 'POST' });
      const nextResults = provider ? [response as ProviderSyncResult] : (response as { results: ProviderSyncResult[] }).results;
      setResults(nextResults);
      if (nextResults.every((item) => item.status === 'completed')) messageApi.success('卡库存同步完成');
      else messageApi.warning('卡库存同步部分完成，请查看 Provider 返回信息');
      await loadCards(filters);
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setSyncing(null);
    }
  };

  const columns: ColumnsType<ProviderCardRow> = [
    { title: 'Provider', dataIndex: 'provider', render: (value) => value === 'airwallex' ? 'Airwallex' : 'PhotonPay' },
    { title: '卡号', dataIndex: 'maskedCardNumber', render: (value) => formatValue(value) },
    { title: '卡昵称', dataIndex: 'nickname', render: (value) => formatValue(value) },
    { title: '卡状态', dataIndex: 'providerStatus', render: (value) => formatValue(value) },
    { title: '持卡人邮箱', dataIndex: 'cardholderEmail', render: (value) => formatValue(value) },
    { title: '匹配员工', key: 'employee', render: (_, row) => row.employeeName ? `${row.employeeCode ?? ''} ${row.employeeName}`.trim() : '-' },
    {
      title: '匹配结果', dataIndex: 'matchStatus',
      render: (value, row) => <Space><Tag color={value === 'matched' ? 'green' : value === 'conflict' ? 'red' : value === 'excluded' ? 'purple' : 'orange'}>{value}</Tag>{row.unmatchedReasonCode ?? ''}</Space>,
    },
    { title: '最近卡同步', dataIndex: 'lastCardSyncedAt', render: formatDate },
    {
      title: '最近交易同步', key: 'transactionSync',
      render: (_, row) => <span>{formatDate(row.lastTransactionSyncedAt)}<br />{row.lastTransactionSyncStatus ?? '-'}</span>,
    },
  ];

  return (
    <section className="page-section data-page">
      {messageHolder}
      <div className="data-page-header">
        <div>
          <Typography.Title level={3}>虚拟卡自动关联</Typography.Title>
          <Typography.Text type="secondary">系统从 Airwallex、PhotonPay 自动发现全部卡，并仅按持卡人邮箱精确关联唯一在职员工。</Typography.Text>
        </div>
        <Space wrap>
          <Button onClick={() => void loadCards(filters)} loading={loading}>刷新列表</Button>
          {canSync ? <Button onClick={() => void syncCards('airwallex')} loading={syncing === 'airwallex'}>同步 Airwallex</Button> : null}
          {canSync ? <Button onClick={() => void syncCards('photonpay')} loading={syncing === 'photonpay'}>同步 PhotonPay</Button> : null}
          {canSync ? <Button type="primary" onClick={() => void syncCards()} loading={syncing === 'all'}>同步全部卡</Button> : null}
        </Space>
      </div>
      <Alert type="info" showIcon message="无需填写外部卡 ID、员工 ID 或生效月份。未匹配、重复邮箱、停用员工和冲突映射不会进入工资花费。" />
      <PhotonPayCardGovernancePanel cards={rows} onChanged={() => loadCards(filters)} />
      {results.map((result) => (
        <Alert
          key={result.provider}
          className="data-page-notice"
          type={result.status === 'completed' ? 'success' : result.status === 'external_blocked' ? 'error' : 'warning'}
          showIcon
          message={`${result.provider}: ${result.status}; cards=${result.discoveredCount}, matched=${result.matchedCount}, unmatched=${result.unmatchedCount}, conflict=${result.conflictCount}, missingId=${result.invalidCardCount ?? 0}`}
          description={result.error ? `HTTP ${result.error.httpStatus ?? '-'} / ${result.error.code ?? result.error.category ?? '-'} / ${result.error.message ?? '-'} / requestId ${result.error.requestId ?? '-'} / API ${result.error.apiVersion ?? result.apiVersion ?? '-'}` : undefined}
        />
      ))}
      <Form layout="inline" className="data-filter" onFinish={(values) => { setFilters(values); void loadCards(values); }}>
        <Form.Item name="provider" label="Provider"><Select allowClear style={{ width: 160 }} options={PROVIDER_OPTIONS} /></Form.Item>
        <Form.Item name="matchStatus" label="匹配状态"><Select allowClear style={{ width: 160 }} options={['matched', 'unmatched', 'conflict', 'excluded'].map((value) => ({ label: value, value }))} /></Form.Item>
        <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
      </Form>
      <Space wrap className="data-page-notice">
        {Object.entries(summary).map(([key, value]) => <Tag key={key}>{key}: {value}</Tag>)}
      </Space>
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} scroll={{ x: 'max-content' }} />
    </section>
  );
}

function GenericBaseDataPage({ path }: { path: string }) {
  const config = PAGE_CONFIGS[path];
  const [records, setRecords] = useState<BaseRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<BaseRecord | null>(null);
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, unknown>>({});
  const [form] = Form.useForm();
  const [filterForm] = Form.useForm();
  const [referenceOptions, setReferenceOptions] = useState<Record<OptionSource, { label: string; value: string }[]>>({
    affiliateAccounts: [],
    employees: [],
  });
  const selectedAffiliatePlatform = Form.useWatch('platform', form);
  const [messageApi, messageHolder] = message.useMessage();
  const [modalApi, modalHolder] = Modal.useModal();

  const load = useCallback(
    async (nextFilters: Record<string, unknown>) => {
      setLoading(true);
      try {
        const query = normalizePayload(nextFilters, config.fields.filter((field) => field.filter));
        const search = new URLSearchParams(query as Record<string, string>).toString();
        const data = await apiClient.request<unknown>(`${config.endpoint}${search ? `?${search}` : ''}`);
        setRecords(normalizeRecords(data));
      } catch (error) {
        messageApi.error(errorMessage(error));
      } finally {
        setLoading(false);
      }
    },
    [config, messageApi],
  );

  useEffect(() => {
    void load({});
  }, [load]);

  useEffect(() => {
    const sources = new Set(config.fields.map((field) => field.optionSource).filter((source): source is OptionSource => Boolean(source)));
    if (sources.size === 0) return;
    let cancelled = false;
    void Promise.all([
      sources.has('affiliateAccounts')
        ? apiClient.request<BaseRecord[]>('/affiliate-accounts')
        : Promise.resolve([]),
      sources.has('employees')
        ? apiClient.request<BaseRecord[]>('/employees')
        : Promise.resolve([]),
    ]).then(([accounts, employees]) => {
      if (cancelled) return;
      setReferenceOptions({
        affiliateAccounts: buildAffiliateAccountOptions(accounts),
        employees: buildEmployeeOptions(employees),
      });
    }).catch((error) => {
      if (!cancelled) messageApi.error(`下拉选项加载失败：${errorMessage(error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [config.fields, messageApi]);

  const fieldOptions = useCallback(
    (field: FieldConfig) => field.optionSource ? referenceOptions[field.optionSource] : field.options ?? [],
    [referenceOptions],
  );

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(
      editing
        ? normalizeForForm(editing, config.fields.filter((field) => field.create !== false), config.customForm)
        : config.defaultCreateValues ?? {},
    );
  }, [config.customForm, config.defaultCreateValues, config.fields, editing, form, open]);

  const editableFields = useMemo(() => config.fields.filter((field) => field.create !== false), [config.fields]);
  const filterFields = useMemo(() => config.fields.filter((field) => field.filter), [config.fields]);

  const runAction = useCallback(
    (action: ActionType, record: BaseRecord) => {
      const isConfirm = action === 'confirm';
      const isReturnToDraft = action === 'returnToDraft';
      const endpointAction = isReturnToDraft ? 'disable' : action;
      modalApi.confirm({
        title: isConfirm ? '确认该记录？' : isReturnToDraft ? '确认退回草稿？' : '确认禁用？',
        content: isConfirm
          ? `确认后该记录状态会变为 confirmed。记录 ID：${record.id}`
          : isReturnToDraft
            ? `该操作会将手动卡花费退回 draft 状态。记录 ID：${record.id}`
            : `该操作会调用后端禁用接口。记录 ID：${record.id}`,
        okText: isConfirm ? '确认' : isReturnToDraft ? '确认退回草稿' : '确认禁用',
        okButtonProps: { danger: !isConfirm },
        cancelText: '取消',
        async onOk() {
          try {
            await apiClient.request(`${config.endpoint}/${record.id}/${endpointAction}`, { method: 'PATCH' });
            messageApi.success(isConfirm ? '已确认' : isReturnToDraft ? '已退回草稿' : '已禁用');
            await load(filters);
          } catch (error) {
            messageApi.error(errorMessage(error));
          }
        },
      });
    },
    [config.endpoint, filters, load, messageApi, modalApi],
  );

  const columns = useMemo<ColumnsType<BaseRecord>>(() => {
    const dataColumns: ColumnsType<BaseRecord> = config.fields
      .filter((field) => field.list !== false)
      .map((field) => ({
        title: field.label,
        dataIndex: field.name,
        key: field.name,
        render: (value: unknown, record: BaseRecord) => {
          if (field.render) return field.render(record);
          if (field.name === 'status') return <Tag color={statusColor(value)}>{statusText(value)}</Tag>;
          if (field.type === 'select') {
            return fieldOptions(field).find((option) => option.value === value)?.label ?? formatValue(value);
          }
          if (field.type === 'month') return formatMonth(value);
          if (field.type === 'date') return formatDate(value);
          return formatValue(value);
        },
      }));

    return [
      ...dataColumns,
      { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', render: formatDate },
      { title: '更新时间', dataIndex: 'updatedAt', key: 'updatedAt', render: formatDate },
      {
        title: '操作',
        key: 'actions',
        fixed: 'right',
        render: (_, record) => (
          <Space>
            <Button
              size="small"
              onClick={() => {
                setEditing(record);
                setOpen(true);
              }}
            >
              编辑
            </Button>
            {config.actions?.includes('confirm') ? (
              <Button size="small" disabled={record.status === 'confirmed'} onClick={() => runAction('confirm', record)}>
                确认
              </Button>
            ) : null}
            {config.actions?.includes('returnToDraft') ? (
              <Button size="small" disabled={record.status === 'draft'} onClick={() => runAction('returnToDraft', record)}>
                退回草稿
              </Button>
            ) : null}
            {config.actions?.includes('disable') ? (
              <Button
                danger
                size="small"
                disabled={record.status === 'disabled'}
                onClick={() => runAction('disable', record)}
              >
                禁用
              </Button>
            ) : null}
          </Space>
        ),
      },
    ];
  }, [config.actions, config.customForm, config.fields, editableFields, fieldOptions, form, runAction]);

  const submit = async () => {
    let values: Record<string, unknown>;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload =
        config.customForm === 'performanceGroup'
          ? normalizePerformanceGroupPayload(values, editableFields)
          : normalizePayload(values, editableFields, Boolean(editing));
    } catch (error) {
      messageApi.error(errorMessage(error));
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await apiClient.request(`${config.endpoint}/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiClient.request(config.endpoint, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      messageApi.success(editing ? '已保存' : '已新增');
      setOpen(false);
      setEditing(null);
      form.resetFields();
      await load(filters);
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="page-section data-page">
      {messageHolder}
      {modalHolder}
      <div className="data-page-header">
        <Typography.Title level={3}>{config.title}</Typography.Title>
        <Space wrap>
          <Button onClick={() => load(filters)} loading={loading}>
            刷新
          </Button>
          <Button
            type="primary"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            新增
          </Button>
        </Space>
      </div>

      {config.notice ? <Alert className="data-page-notice" type="info" showIcon message={config.notice} /> : null}

      {filterFields.length ? (
        <Form
          form={filterForm}
          layout="inline"
          className="data-filter"
          onFinish={(values) => {
            setFilters(values);
            void load(values);
          }}
        >
          {filterFields.map((field) => (
            <Form.Item key={field.name} name={field.name} label={field.label}>
              <FieldControl field={{ ...field, options: fieldOptions(field) }} />
            </Form.Item>
          ))}
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit">
                查询
              </Button>
              <Button
                onClick={() => {
                  filterForm.resetFields();
                  setFilters({});
                  void load({});
                }}
              >
                重置
              </Button>
            </Space>
          </Form.Item>
        </Form>
      ) : null}

      <Table rowKey="id" columns={columns} dataSource={records} loading={loading} scroll={{ x: 'max-content' }} />

      <Modal
        title={editing ? `编辑${config.title}` : `新增${config.title}`}
        open={open}
        confirmLoading={saving}
        okText="提交"
        cancelText="取消"
        width={config.customForm === 'performanceGroup' || path === '/card-bindings' ? 760 : 560}
        onOk={() => void submit()}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
          form.resetFields();
        }}
        forceRender
      >
        <Form form={form} layout="vertical" preserve={false}>
          {editableFields.map((field) => {
            const label =
              path === '/affiliate-accounts' && field.name === 'accountCode'
                ? selectedAffiliatePlatform === 'cake'
                  ? 'Affiliate ID'
                  : '账号编码'
                : field.label;
            return (
              <Form.Item
                key={field.name}
                name={field.name}
                label={label}
                help={field.help}
                validateTrigger={['onChange', 'onBlur']}
                rules={[{ required: field.required, whitespace: field.type !== 'select', message: `请填写${label}` }]}
              >
                <FieldControl
                  field={{ ...field, label, options: fieldOptions(field) }}
                  onValueChange={() => {
                    queueMicrotask(() => {
                      void form.validateFields([field.name]).catch(() => undefined);
                    });
                  }}
                />
              </Form.Item>
            );
          })}
          {config.customForm === 'performanceGroup' ? <PerformanceGroupMembersForm /> : null}
        </Form>
      </Modal>
    </section>
  );
}
