import { Alert, Button, Form, Input, Select, Space, Statistic, Table, Tabs, Tag, Typography, message } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import {
  CARD_PROVIDER_FILTER_OPTIONS,
  EMPLOYEE_SUMMARY_COLUMNS,
  UNMATCHED_LIMITATION_NOTICE,
  buildQuery,
  defaultGmt8Month,
  displaySyncTaskId,
  formatDateTime,
  isNegativeUsd,
  textValue,
} from './sync-reconciliation-utils';

type TabKey = 'employee-summary' | 'affiliate-income' | 'card-spend' | 'unmatched';
type UnmatchedType = 'all' | 'affiliate_income' | 'card_spend';

type EmployeeOption = {
  id: string;
  name?: string | null;
  employeeCode?: string | null;
};

type AffiliateAccountOption = {
  id: string;
  platform: string;
  accountCode: string;
  accountName?: string | null;
};

type EmployeeSummaryRow = {
  employeeId: string;
  employeeName?: string | null;
  affiliateRevenueUsd: string;
  apiCardSpendUsd: string;
  manualCardSpendUsd: string;
  rawGrossProfitUsd: string;
  unmatchedFlags?: string[];
  warnings?: string[];
};

type AffiliateIncomeRow = {
  id: string;
  affiliateAccountName?: string | null;
  affiliateAccountCode?: string | null;
  platform?: 'everflow' | 'cake' | null;
  thirdPartyConversionId?: string | null;
  subId?: string | null;
  employeeName?: string | null;
  employeeId?: string | null;
  revenueUsd: string;
  conversionTime?: string | null;
  eventTime?: string | null;
  rawStatus?: string | null;
  importedBy?: string | null;
  syncTaskId?: string | null;
  createdAt?: string | null;
};

type CardSpendRow = {
  id: string;
  provider?: 'airwallex' | 'photonpay' | null;
  employeeName?: string | null;
  employeeId?: string | null;
  cardId?: string | null;
  cardLast4?: string | null;
  cardEmail?: string | null;
  transactionId?: string | null;
  transactionAt?: string | null;
  settledAt?: string | null;
  amountUsd: string;
  status?: string | null;
  settleStatus?: string | null;
  importedBy?: string | null;
  syncTaskId?: string | null;
  createdAt?: string | null;
};

type AffiliateIncomeSummary = {
  totalRevenueUsd: string;
  matchedRevenueUsd: string;
  unmatchedRevenueUsd: string;
  eventCount: number;
  matchedCount: number;
  unmatchedCount: number;
};

type CardSpendSummary = {
  totalSpendUsd: string;
  matchedSpendUsd: string;
  unmatchedSpendUsd: string;
  eventCount: number;
  matchedCount: number;
  unmatchedCount: number;
};

type PagedPayload<T, S> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  summary: S;
};

type UnmatchedAffiliateIncomeRow = Pick<
  AffiliateIncomeRow,
  'id' | 'affiliateAccountName' | 'platform' | 'thirdPartyConversionId' | 'subId' | 'revenueUsd' | 'importedBy' | 'createdAt'
> & {
  reason: string;
};

type UnmatchedCardSpendRow = Pick<
  CardSpendRow,
  'id' | 'provider' | 'cardId' | 'cardLast4' | 'cardEmail' | 'transactionId' | 'transactionAt' | 'amountUsd' | 'importedBy' | 'createdAt'
> & {
  reason: string;
};

type UnmatchedPayload = {
  limitation?: string;
  warnings?: string[];
  affiliateIncomeEvents: UnmatchedAffiliateIncomeRow[];
  cardSpendEvents: UnmatchedCardSpendRow[];
};

const PAGE_SIZE = 20;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试。';
}

function employeeLabel(employee: EmployeeOption): string {
  const code = employee.employeeCode ? ` / ${employee.employeeCode}` : '';
  return `${employee.name ?? employee.id}${code} / ${employee.id}`;
}

function accountLabel(account: AffiliateAccountOption): string {
  return `${account.accountName?.trim() || account.accountCode} / ${account.accountCode} / ${account.platform}`;
}

function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function SummaryStats({ values }: { values: { label: string; value: string | number }[] }) {
  return (
    <div className="reconciliation-summary">
      {values.map((item) => (
        <Statistic key={item.label} title={item.label} value={item.value} />
      ))}
    </div>
  );
}

export function SyncReconciliationPage() {
  const [messageApi, messageHolder] = message.useMessage();
  const [settlementMonth, setSettlementMonth] = useState(defaultGmt8Month());
  const [activeTab, setActiveTab] = useState<TabKey>('employee-summary');
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [affiliateAccounts, setAffiliateAccounts] = useState<AffiliateAccountOption[]>([]);

  const [employeeRows, setEmployeeRows] = useState<EmployeeSummaryRow[]>([]);
  const [employeeLoading, setEmployeeLoading] = useState(false);

  const [affiliateRows, setAffiliateRows] = useState<AffiliateIncomeRow[]>([]);
  const [affiliateSummary, setAffiliateSummary] = useState<AffiliateIncomeSummary | null>(null);
  const [affiliateLoading, setAffiliateLoading] = useState(false);
  const [affiliateTotal, setAffiliateTotal] = useState(0);
  const [affiliatePage, setAffiliatePage] = useState(1);
  const [affiliatePageSize, setAffiliatePageSize] = useState(PAGE_SIZE);
  const [affiliateFilters, setAffiliateFilters] = useState<Record<string, unknown>>({});
  const [affiliateExporting, setAffiliateExporting] = useState(false);

  const [cardRows, setCardRows] = useState<CardSpendRow[]>([]);
  const [cardSummary, setCardSummary] = useState<CardSpendSummary | null>(null);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardTotal, setCardTotal] = useState(0);
  const [cardPage, setCardPage] = useState(1);
  const [cardPageSize, setCardPageSize] = useState(PAGE_SIZE);
  const [cardFilters, setCardFilters] = useState<Record<string, unknown>>({});

  const [unmatched, setUnmatched] = useState<UnmatchedPayload | null>(null);
  const [unmatchedLoading, setUnmatchedLoading] = useState(false);
  const [unmatchedType, setUnmatchedType] = useState<UnmatchedType>('all');

  const loadOptions = useCallback(async () => {
    try {
      const [employeeData, accountData] = await Promise.all([
        apiClient.request<EmployeeOption[]>('/employees?status=active'),
        apiClient.request<AffiliateAccountOption[]>('/affiliate-accounts?status=active'),
      ]);
      setEmployees(employeeData);
      setAffiliateAccounts(accountData);
    } catch (error) {
      messageApi.error(errorMessage(error));
    }
  }, [messageApi]);

  const loadEmployeeSummary = useCallback(async () => {
    setEmployeeLoading(true);
    try {
      const rows = await apiClient.request<EmployeeSummaryRow[]>(
        `/sync-reconciliation/monthly-employee-summary?${buildQuery({ settlementMonth })}`,
      );
      setEmployeeRows(rows);
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setEmployeeLoading(false);
    }
  }, [messageApi, settlementMonth]);

  const loadAffiliateIncome = useCallback(
    async (page = affiliatePage, pageSize = affiliatePageSize, filters = affiliateFilters) => {
      setAffiliateLoading(true);
      try {
        const payload = await apiClient.request<PagedPayload<AffiliateIncomeRow, AffiliateIncomeSummary>>(
          `/sync-reconciliation/affiliate-income?${buildQuery({ settlementMonth, page, pageSize, ...filters })}`,
        );
        setAffiliateRows(payload.items);
        setAffiliateSummary(payload.summary);
        setAffiliateTotal(payload.total);
        setAffiliatePage(payload.page);
        setAffiliatePageSize(payload.pageSize);
      } catch (error) {
        messageApi.error(errorMessage(error));
      } finally {
        setAffiliateLoading(false);
      }
    },
    [affiliateFilters, affiliatePage, affiliatePageSize, messageApi, settlementMonth],
  );

  const loadCardSpend = useCallback(
    async (page = cardPage, pageSize = cardPageSize, filters = cardFilters) => {
      setCardLoading(true);
      try {
        const payload = await apiClient.request<PagedPayload<CardSpendRow, CardSpendSummary>>(
          `/sync-reconciliation/card-spend?${buildQuery({ settlementMonth, page, pageSize, ...filters })}`,
        );
        setCardRows(payload.items);
        setCardSummary(payload.summary);
        setCardTotal(payload.total);
        setCardPage(payload.page);
        setCardPageSize(payload.pageSize);
      } catch (error) {
        messageApi.error(errorMessage(error));
      } finally {
        setCardLoading(false);
      }
    },
    [cardFilters, cardPage, cardPageSize, messageApi, settlementMonth],
  );

  const exportAffiliatePayout = useCallback(async () => {
    setAffiliateExporting(true);
    try {
      const csv = await apiClient.request<string>(
        `/sync-reconciliation/affiliate-income/export.csv?${buildQuery({ settlementMonth, ...affiliateFilters })}`,
      );
      downloadCsv(`affiliate-payout-${settlementMonth}.csv`, csv);
      messageApi.success('payout CSV 已导出。');
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setAffiliateExporting(false);
    }
  }, [affiliateFilters, messageApi, settlementMonth]);

  const loadUnmatched = useCallback(async () => {
    setUnmatchedLoading(true);
    try {
      const payload = await apiClient.request<UnmatchedPayload>(
        `/sync-reconciliation/unmatched?${buildQuery({ settlementMonth, type: unmatchedType })}`,
      );
      setUnmatched(payload);
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setUnmatchedLoading(false);
    }
  }, [messageApi, settlementMonth, unmatchedType]);

  const refreshCurrent = useCallback(() => {
    if (activeTab === 'employee-summary') return loadEmployeeSummary();
    if (activeTab === 'affiliate-income') return loadAffiliateIncome(1, affiliatePageSize);
    if (activeTab === 'card-spend') return loadCardSpend(1, cardPageSize);
    return loadUnmatched();
  }, [activeTab, affiliatePageSize, cardPageSize, loadAffiliateIncome, loadCardSpend, loadEmployeeSummary, loadUnmatched]);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    void refreshCurrent();
  }, [refreshCurrent]);

  const employeeColumns = useMemo<ColumnsType<EmployeeSummaryRow>>(
    () => [
      { title: 'employeeName', dataIndex: 'employeeName', key: 'employeeName', render: textValue },
      { title: 'employeeId', dataIndex: 'employeeId', key: 'employeeId', render: textValue },
      { title: 'affiliateRevenueUsd', dataIndex: 'affiliateRevenueUsd', key: 'affiliateRevenueUsd' },
      { title: 'apiCardSpendUsd', dataIndex: 'apiCardSpendUsd', key: 'apiCardSpendUsd' },
      { title: 'manualCardSpendUsd', dataIndex: 'manualCardSpendUsd', key: 'manualCardSpendUsd' },
      {
        title: 'rawGrossProfitUsd',
        dataIndex: 'rawGrossProfitUsd',
        key: 'rawGrossProfitUsd',
        render: (value) => <Typography.Text type={isNegativeUsd(value) ? 'danger' : undefined}>{textValue(value)}</Typography.Text>,
      },
      {
        title: 'unmatchedFlags / warnings',
        key: 'warnings',
        render: (_, record) => textValue(record.unmatchedFlags?.length ? record.unmatchedFlags : record.warnings),
      },
    ],
    [],
  );

  const affiliateColumns = useMemo<ColumnsType<AffiliateIncomeRow>>(
    () => [
      { title: 'affiliateAccountName', dataIndex: 'affiliateAccountName', key: 'affiliateAccountName', render: textValue },
      { title: 'affiliateAccountCode', dataIndex: 'affiliateAccountCode', key: 'affiliateAccountCode', render: textValue },
      { title: 'platform', dataIndex: 'platform', key: 'platform', render: (value) => (value === 'everflow' || value === 'cake' ? value : '-') },
      { title: 'thirdPartyConversionId', dataIndex: 'thirdPartyConversionId', key: 'thirdPartyConversionId', render: textValue },
      { title: 'subId', dataIndex: 'subId', key: 'subId', render: textValue },
      { title: 'employeeName', dataIndex: 'employeeName', key: 'employeeName', render: textValue },
      { title: 'employeeId', dataIndex: 'employeeId', key: 'employeeId', render: textValue },
      { title: 'payout USD', dataIndex: 'revenueUsd', key: 'revenueUsd' },
      { title: '销售/转化时间 GMT+8', key: 'eventTime', render: (_, record) => formatDateTime(record.conversionTime ?? record.eventTime) },
      { title: 'disposition/status', dataIndex: 'rawStatus', key: 'rawStatus', render: textValue },
      { title: 'importedBy', dataIndex: 'importedBy', key: 'importedBy', render: textValue },
      { title: 'syncTaskId', dataIndex: 'syncTaskId', key: 'syncTaskId', render: displaySyncTaskId },
      { title: 'createdAt', dataIndex: 'createdAt', key: 'createdAt', render: formatDateTime },
    ],
    [],
  );

  const cardColumns = useMemo<ColumnsType<CardSpendRow>>(
    () => [
      { title: 'provider', dataIndex: 'provider', key: 'provider', render: textValue },
      { title: 'employeeName', dataIndex: 'employeeName', key: 'employeeName', render: textValue },
      { title: 'employeeId', dataIndex: 'employeeId', key: 'employeeId', render: textValue },
      { title: 'cardId', dataIndex: 'cardId', key: 'cardId', render: textValue },
      { title: 'cardLast4', dataIndex: 'cardLast4', key: 'cardLast4', render: textValue },
      { title: 'cardEmail', dataIndex: 'cardEmail', key: 'cardEmail', render: textValue },
      { title: 'transactionId', dataIndex: 'transactionId', key: 'transactionId', render: textValue },
      { title: 'transactionAt', dataIndex: 'transactionAt', key: 'transactionAt', render: formatDateTime },
      { title: 'settledAt', dataIndex: 'settledAt', key: 'settledAt', render: formatDateTime },
      { title: 'amountUsd', dataIndex: 'amountUsd', key: 'amountUsd' },
      { title: 'status', dataIndex: 'status', key: 'status', render: textValue },
      { title: 'settleStatus', dataIndex: 'settleStatus', key: 'settleStatus', render: textValue },
      { title: 'importedBy', dataIndex: 'importedBy', key: 'importedBy', render: textValue },
      { title: 'syncTaskId', dataIndex: 'syncTaskId', key: 'syncTaskId', render: displaySyncTaskId },
      { title: 'createdAt', dataIndex: 'createdAt', key: 'createdAt', render: formatDateTime },
    ],
    [],
  );

  const unmatchedAffiliateColumns = useMemo<ColumnsType<UnmatchedAffiliateIncomeRow>>(
    () => [
      { title: 'reason', dataIndex: 'reason', key: 'reason', render: (value) => <Tag color="orange">{textValue(value)}</Tag> },
      { title: 'affiliateAccountName', dataIndex: 'affiliateAccountName', key: 'affiliateAccountName', render: textValue },
      { title: 'platform', dataIndex: 'platform', key: 'platform', render: (value) => (value === 'everflow' || value === 'cake' ? value : '-') },
      { title: 'thirdPartyConversionId', dataIndex: 'thirdPartyConversionId', key: 'thirdPartyConversionId', render: textValue },
      { title: 'subId', dataIndex: 'subId', key: 'subId', render: textValue },
      { title: 'revenueUsd', dataIndex: 'revenueUsd', key: 'revenueUsd' },
      { title: 'importedBy', dataIndex: 'importedBy', key: 'importedBy', render: textValue },
      { title: 'createdAt', dataIndex: 'createdAt', key: 'createdAt', render: formatDateTime },
    ],
    [],
  );

  const unmatchedCardColumns = useMemo<ColumnsType<UnmatchedCardSpendRow>>(
    () => [
      { title: 'reason', dataIndex: 'reason', key: 'reason', render: (value) => <Tag color="orange">{textValue(value)}</Tag> },
      { title: 'provider', dataIndex: 'provider', key: 'provider', render: textValue },
      { title: 'cardId', dataIndex: 'cardId', key: 'cardId', render: textValue },
      { title: 'cardLast4', dataIndex: 'cardLast4', key: 'cardLast4', render: textValue },
      { title: 'cardEmail', dataIndex: 'cardEmail', key: 'cardEmail', render: textValue },
      { title: 'transactionId', dataIndex: 'transactionId', key: 'transactionId', render: textValue },
      { title: 'transactionAt', dataIndex: 'transactionAt', key: 'transactionAt', render: formatDateTime },
      { title: 'amountUsd', dataIndex: 'amountUsd', key: 'amountUsd' },
      { title: 'importedBy', dataIndex: 'importedBy', key: 'importedBy', render: textValue },
      { title: 'createdAt', dataIndex: 'createdAt', key: 'createdAt', render: formatDateTime },
    ],
    [],
  );

  const employeeOptions = employees.map((employee) => ({ value: employee.id, label: employeeLabel(employee) }));
  const accountOptions = affiliateAccounts.map((account) => ({ value: account.id, label: accountLabel(account) }));

  return (
    <section className="page-section data-page">
      {messageHolder}
      <div className="data-page-header">
        <div>
          <Typography.Title level={3}>同步数据核对</Typography.Title>
          <Typography.Text type="secondary">按结算月份核对同步入库数据；这里是核对汇总，不是正式工资结果。</Typography.Text>
        </div>
        <Space wrap>
          <Input
            type="month"
            value={settlementMonth}
            onChange={(event) => setSettlementMonth(event.target.value || defaultGmt8Month())}
          />
          <Button onClick={() => void refreshCurrent()}>刷新</Button>
        </Space>
      </div>

      <Alert
        className="data-page-notice"
        type="info"
        showIcon
        message="同步数据核对口径"
        description="员工月度预汇总只展示原始收入、API 卡花费、手动卡花费和原始毛利；不展示工资、提成、分组分润或负毛利滚动。"
      />

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as TabKey)}
        items={[
          {
            key: 'employee-summary',
            label: '员工汇总',
            children: (
              <Table
                rowKey="employeeId"
                columns={employeeColumns}
                dataSource={employeeRows}
                loading={employeeLoading}
                scroll={{ x: 'max-content' }}
                pagination={false}
                title={() => `字段：${EMPLOYEE_SUMMARY_COLUMNS.join(', ')}`}
              />
            ),
          },
          {
            key: 'affiliate-income',
            label: '联盟 payout',
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Form
                  layout="inline"
                  className="data-filter"
                  onFinish={(values) => {
                    setAffiliateFilters(values);
                    void loadAffiliateIncome(1, affiliatePageSize, values);
                  }}
                >
                  <Form.Item name="affiliateAccountId" label="联盟账号">
                    <Select allowClear showSearch optionFilterProp="label" style={{ width: 320 }} options={accountOptions} />
                  </Form.Item>
                  <Form.Item name="subId" label="subId">
                    <Input allowClear style={{ width: 180 }} />
                  </Form.Item>
                  <Form.Item name="employeeId" label="员工">
                    <Select allowClear showSearch optionFilterProp="label" style={{ width: 260 }} options={employeeOptions} />
                  </Form.Item>
                  <Form.Item>
                    <Space>
                      <Button type="primary" htmlType="submit">
                        查询
                      </Button>
                      <Button loading={affiliateExporting} onClick={() => void exportAffiliatePayout()}>
                        导出 payout CSV
                      </Button>
                      <Button
                        onClick={() => {
                          setAffiliateFilters({});
                          void loadAffiliateIncome(1, affiliatePageSize, {});
                        }}
                      >
                        重置
                      </Button>
                    </Space>
                  </Form.Item>
                </Form>
                {affiliateSummary ? (
                  <SummaryStats
                    values={[
                      { label: '截至最近同步 payout USD', value: affiliateSummary.totalRevenueUsd },
                      { label: '已归因 payout USD', value: affiliateSummary.matchedRevenueUsd },
                      { label: '未归因 payout USD', value: affiliateSummary.unmatchedRevenueUsd },
                      { label: 'eventCount', value: affiliateSummary.eventCount },
                      { label: 'matchedCount', value: affiliateSummary.matchedCount },
                      { label: 'unmatchedCount', value: affiliateSummary.unmatchedCount },
                    ]}
                  />
                ) : null}
                <Table
                  rowKey="id"
                  columns={affiliateColumns}
                  dataSource={affiliateRows}
                  loading={affiliateLoading}
                  scroll={{ x: 'max-content' }}
                  pagination={{ current: affiliatePage, pageSize: affiliatePageSize, total: affiliateTotal, showSizeChanger: true }}
                  onChange={(pagination: TablePaginationConfig) =>
                    void loadAffiliateIncome(pagination.current ?? 1, pagination.pageSize ?? PAGE_SIZE)
                  }
                />
              </Space>
            ),
          },
          {
            key: 'card-spend',
            label: '虚拟卡花费',
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Form
                  layout="inline"
                  className="data-filter"
                  onFinish={(values) => {
                    setCardFilters(values);
                    void loadCardSpend(1, cardPageSize, values);
                  }}
                >
                  <Form.Item name="provider" label="provider">
                    <Select allowClear style={{ width: 180 }} options={[...CARD_PROVIDER_FILTER_OPTIONS]} />
                  </Form.Item>
                  <Form.Item name="employeeId" label="员工">
                    <Select allowClear showSearch optionFilterProp="label" style={{ width: 260 }} options={employeeOptions} />
                  </Form.Item>
                  <Form.Item>
                    <Space>
                      <Button type="primary" htmlType="submit">
                        查询
                      </Button>
                      <Button
                        onClick={() => {
                          setCardFilters({});
                          void loadCardSpend(1, cardPageSize, {});
                        }}
                      >
                        重置
                      </Button>
                    </Space>
                  </Form.Item>
                </Form>
                {cardSummary ? (
                  <SummaryStats
                    values={[
                      { label: 'totalSpendUsd', value: cardSummary.totalSpendUsd },
                      { label: 'matchedSpendUsd', value: cardSummary.matchedSpendUsd },
                      { label: 'unmatchedSpendUsd', value: cardSummary.unmatchedSpendUsd },
                      { label: 'eventCount', value: cardSummary.eventCount },
                      { label: 'matchedCount', value: cardSummary.matchedCount },
                      { label: 'unmatchedCount', value: cardSummary.unmatchedCount },
                    ]}
                  />
                ) : null}
                <Table
                  rowKey="id"
                  columns={cardColumns}
                  dataSource={cardRows}
                  loading={cardLoading}
                  scroll={{ x: 'max-content' }}
                  pagination={{ current: cardPage, pageSize: cardPageSize, total: cardTotal, showSizeChanger: true }}
                  onChange={(pagination: TablePaginationConfig) => void loadCardSpend(pagination.current ?? 1, pagination.pageSize ?? PAGE_SIZE)}
                />
              </Space>
            ),
          },
          {
            key: 'unmatched',
            label: '未匹配',
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Alert
                  type="warning"
                  showIcon
                  message="未匹配数据范围限制"
                  description={
                    <Space direction="vertical" size={4}>
                      <Typography.Text>{UNMATCHED_LIMITATION_NOTICE}</Typography.Text>
                      {unmatched?.limitation ? <Typography.Text type="secondary">{unmatched.limitation}</Typography.Text> : null}
                      {unmatched?.warnings?.map((warning) => (
                        <Typography.Text key={warning} type="secondary">
                          {warning}
                        </Typography.Text>
                      ))}
                    </Space>
                  }
                />
                <Space wrap>
                  <Select
                    value={unmatchedType}
                    style={{ width: 180 }}
                    options={[
                      { label: 'all', value: 'all' },
                      { label: 'affiliate_income', value: 'affiliate_income' },
                      { label: 'card_spend', value: 'card_spend' },
                    ]}
                    onChange={(value) => setUnmatchedType(value)}
                  />
                  <Button loading={unmatchedLoading} onClick={() => void loadUnmatched()}>
                    查询
                  </Button>
                </Space>
                <Typography.Title level={4}>联盟收入未匹配</Typography.Title>
                <Table
                  rowKey="id"
                  columns={unmatchedAffiliateColumns}
                  dataSource={unmatched?.affiliateIncomeEvents ?? []}
                  loading={unmatchedLoading}
                  scroll={{ x: 'max-content' }}
                  pagination={false}
                />
                <Typography.Title level={4}>卡花费未匹配</Typography.Title>
                <Table
                  rowKey="id"
                  columns={unmatchedCardColumns}
                  dataSource={unmatched?.cardSpendEvents ?? []}
                  loading={unmatchedLoading}
                  scroll={{ x: 'max-content' }}
                  pagination={false}
                />
              </Space>
            ),
          },
        ]}
      />
    </section>
  );
}
