import { Alert, Button, Descriptions, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import { getStoredActor } from '../lib/auth-storage';
import {
  SYNC_OPTIONS,
  canExecuteStatus,
  credentialText,
  formatPayloadValue,
  safeJsonText,
  statusColor,
  statusText,
  type CredentialSummary,
  type SyncTaskStatus,
  type SyncType,
} from './data-sync-utils';

type SettlementStatus = 'draft' | 'confirmed' | 'locked';

type DataSyncForm = {
  settlementMonth: string;
  syncType: SyncType;
  affiliateAccountId?: string;
};

type SettlementSummary = {
  status: SettlementStatus;
  settlement?: {
    id: string;
    settlementMonth: string;
    status: SettlementStatus;
    lockedAt?: string | null;
    lockedBy?: string | null;
    lockReason?: string | null;
  };
};

type AffiliateAccount = {
  id: string;
  platform: string;
  accountCode: string;
  accountName?: string | null;
  status?: string;
};

type AffiliateCredentialRow = {
  affiliateAccountId: string;
  hasCredential: boolean;
  status?: string | null;
  maskedPayload?: unknown;
};

type CardProviderCredentialRow = {
  provider: 'airwallex' | 'photonpay';
  hasCredential: boolean;
  status?: string | null;
  maskedPayload?: unknown;
};

type SyncTaskRecord = {
  id?: string;
  taskId: string;
  sourceType?: string;
  taskType: string;
  provider?: string | null;
  platform?: string | null;
  affiliateAccountId?: string | null;
  affiliateAccount?: AffiliateAccount | null;
  settlementMonth?: string;
  status: SyncTaskStatus | string;
  startedAt?: string | null;
  finishedAt?: string | null;
  successCount?: number;
  failedCount?: number;
  message?: string | null;
  errorMessage?: string | null;
  requestedBy?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  resultPayload?: unknown;
  triggerType?: 'manual' | 'scheduled';
  attemptCount?: number;
  nextAttemptAt?: string | null;
  lastAttemptAt?: string | null;
  lastErrorCategory?: string | null;
  executing?: boolean;
};

type AutoExecutionStatus = {
  enabled: boolean;
  pollSeconds: number;
  batchSize: number;
  maxAttempts: number;
  activeLeaseCount: number;
  pendingEligibleCount: number;
  retryWaitingCount: number;
  permanentlyFailedCount: number;
  lastPollAt?: string | null;
  lastClaimAt?: string | null;
};

type SyncOperationRecord = SyncTaskRecord & {
  maxAttempts?: number;
  lastErrorSafeMessage?: string | null;
  leaseState?: 'none' | 'active' | 'expired';
  actorType?: 'manual' | 'system';
  resultSummary?: unknown;
};

type SyncOperationListPayload = {
  items: SyncOperationRecord[];
  total: number;
  page: number;
  pageSize: number;
};

type SyncOperationDetail = {
  task: SyncOperationRecord;
  retryable: boolean;
  suggestedAction: string;
  recentEvents: Array<{
    id: string;
    action: string;
    result: string;
    failureReason?: string | null;
    errorMessage?: string | null;
    createdAt: string;
    actorUserId?: string | null;
    summary?: unknown;
  }>;
};

type SyncTaskListPayload = {
  items: SyncTaskRecord[];
  total: number;
  page: number;
  pageSize: number;
};

type PlanningCandidate = {
  sourceType: string;
  taskType: string;
  settlementMonth: string;
  affiliateAccountId: string | null;
  affiliateAccountName: string | null;
  platform: string | null;
  provider: string | null;
  credentialConfigured: boolean;
  existingTaskId: string | null;
  canCreate: boolean;
  blockerCodes: string[];
};

type PlanningPreview = {
  settlementMonth: string;
  locked: boolean;
  candidates: PlanningCandidate[];
  summary: { candidateCount: number; creatableCount: number; existingCount: number; blockedCount: number };
};

const DEFAULT_PAGE_SIZE = 20;

function defaultMonth(): string {
  const now = new Date();
  const gmt8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return `${gmt8.getUTCFullYear()}-${String(gmt8.getUTCMonth() + 1).padStart(2, '0')}`;
}

function formatTime(value: unknown): string {
  if (typeof value !== 'string' || !value) return '-';
  return value.replace('T', ' ').slice(0, 19);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试。';
}

function buildSyncTaskQuery(month: string, syncType: SyncType, page: number, pageSize: number): string {
  const params = new URLSearchParams({
    settlementMonth: month,
    page: String(page),
    pageSize: String(pageSize),
  });
  if (syncType !== 'task_records') params.set('taskType', syncType);
  return params.toString();
}

function accountLabel(account: AffiliateAccount): string {
  const name = account.accountName?.trim() || '-';
  return `${name} / ${account.accountCode} / ${account.platform}`;
}

function countText(value: unknown): string | number {
  return typeof value === 'number' ? value : '-';
}

function taskSubject(record: SyncTaskRecord): string {
  if (record.sourceType === 'affiliate_income' || record.taskType === 'affiliate_income') {
    if (record.affiliateAccount) return accountLabel(record.affiliateAccount);
    return record.affiliateAccountId ?? record.platform ?? '-';
  }
  return record.provider ?? record.platform ?? '-';
}

function taskCredentialKey(record: SyncTaskRecord): string | null {
  if (record.sourceType === 'affiliate_income' || record.taskType === 'affiliate_income') {
    return record.affiliateAccountId ? `affiliate:${record.affiliateAccountId}` : null;
  }
  return record.provider ? `card:${record.provider}` : null;
}

function taskPlatformOrProvider(record: SyncTaskRecord): string {
  if (record.sourceType === 'affiliate_income' || record.taskType === 'affiliate_income') {
    return record.platform ?? record.affiliateAccount?.platform ?? '-';
  }
  return record.provider ?? record.platform ?? '-';
}

function leaseStateText(state?: string): string {
  if (state === 'active') return '执行中';
  if (state === 'expired') return '租约已过期';
  return '无租约';
}

function canRequestRetryStatus(status: string): boolean {
  return status === 'failed' || status === 'retry_wait';
}

function canCancelOperation(record: SyncOperationRecord): boolean {
  if (['pending', 'retry_wait', 'failed'].includes(record.status)) return true;
  return record.status === 'running' && record.leaseState === 'expired';
}

export function DataSyncPage() {
  const [form] = Form.useForm<DataSyncForm>();
  const [messageApi, messageHolder] = message.useMessage();
  const [modalApi, modalHolder] = Modal.useModal();
  const [settlementStatus, setSettlementStatus] = useState<SettlementStatus | 'none' | 'unknown'>('unknown');
  const [settlementError, setSettlementError] = useState<string | null>(null);
  const [checkingSettlement, setCheckingSettlement] = useState(false);
  const [affiliateAccounts, setAffiliateAccounts] = useState<AffiliateAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [credentialMap, setCredentialMap] = useState<Record<string, CredentialSummary>>({});
  const [loadingCredentials, setLoadingCredentials] = useState(false);
  const [tasks, setTasks] = useState<SyncTaskRecord[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [tasksTotal, setTasksTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [creatingTask, setCreatingTask] = useState(false);
  const [executingTaskId, setExecutingTaskId] = useState<string | null>(null);
  const [planningPreview, setPlanningPreview] = useState<PlanningPreview | null>(null);
  const [loadingPlanning, setLoadingPlanning] = useState(false);
  const [generatingPlanning, setGeneratingPlanning] = useState(false);
  const [autoExecutionStatus, setAutoExecutionStatus] = useState<AutoExecutionStatus | null>(null);
  const [operationTasks, setOperationTasks] = useState<SyncOperationRecord[]>([]);
  const [loadingOperations, setLoadingOperations] = useState(false);
  const [operationStatusFilter, setOperationStatusFilter] = useState<string | undefined>();
  const [operationTriggerFilter, setOperationTriggerFilter] = useState<string | undefined>();
  const [operationAbnormalOnly, setOperationAbnormalOnly] = useState(false);
  const [operationDetail, setOperationDetail] = useState<SyncOperationDetail | null>(null);
  const [loadingOperationDetail, setLoadingOperationDetail] = useState(false);
  const [operationActionTaskId, setOperationActionTaskId] = useState<string | null>(null);

  const settlementMonth = Form.useWatch('settlementMonth', form) ?? defaultMonth();
  const syncType = Form.useWatch('syncType', form) ?? 'affiliate_income';
  const affiliateAccountId = Form.useWatch('affiliateAccountId', form);
  const selectedOption = useMemo(
    () => SYNC_OPTIONS.find((option) => option.value === syncType) ?? SYNC_OPTIONS[0],
    [syncType],
  );
  const isLocked = settlementStatus === 'locked';
  const canCreateTask = Boolean(selectedOption.endpoint) && selectedOption.value !== 'task_records';
  const actorPermissions = getStoredActor()?.permissions ?? [];
  const canGeneratePlanning = actorPermissions.includes('income.import') && actorPermissions.includes('manual_card_spend.manage');
  const canExecuteTask = useCallback((record: SyncTaskRecord) => {
    const requiredPermission = record.sourceType === 'affiliate_income' || record.taskType === 'affiliate_income'
      ? 'income.import'
      : 'manual_card_spend.manage';
    return actorPermissions.includes(requiredPermission);
  }, [actorPermissions]);

  const loadPlanningPreview = useCallback(async () => {
    setLoadingPlanning(true);
    try {
      const result = await apiClient.request<PlanningPreview>(`/sync-planning/preview?settlementMonth=${encodeURIComponent(settlementMonth)}`);
      setPlanningPreview(result);
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setLoadingPlanning(false);
    }
  }, [messageApi, settlementMonth]);

  const loadSettlementStatus = useCallback(
    async (month: string) => {
      if (!month) return;
      setCheckingSettlement(true);
      setSettlementError(null);
      try {
        const summary = await apiClient.request<SettlementSummary>(`/settlements/${month}`);
        setSettlementStatus(summary.status ?? summary.settlement?.status ?? 'unknown');
      } catch (error) {
        if (error instanceof ApiError && error.code === 'SETTLEMENT_NOT_FOUND') {
          setSettlementStatus('none');
          return;
        }
        setSettlementStatus('unknown');
        setSettlementError(errorMessage(error));
      } finally {
        setCheckingSettlement(false);
      }
    },
    [],
  );

  const loadAffiliateAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      const accounts = await apiClient.request<AffiliateAccount[]>('/affiliate-accounts?status=active');
      setAffiliateAccounts(accounts);
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setLoadingAccounts(false);
    }
  }, [messageApi]);

  const loadCredentials = useCallback(async () => {
    setLoadingCredentials(true);
    try {
      const [affiliateRows, cardRows] = await Promise.all([
        apiClient.request<AffiliateCredentialRow[]>('/api-credentials/affiliate-accounts'),
        apiClient.request<CardProviderCredentialRow[]>('/api-credentials/card-providers'),
      ]);

      const nextMap: Record<string, CredentialSummary> = {};
      affiliateRows.forEach((row) => {
        nextMap[`affiliate:${row.affiliateAccountId}`] = row;
      });
      cardRows.forEach((row) => {
        nextMap[`card:${row.provider}`] = row;
      });
      setCredentialMap(nextMap);
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setLoadingCredentials(false);
    }
  }, [messageApi]);

  const loadTasks = useCallback(
    async (nextPage: number, nextPageSize: number, nextMonth: string, nextSyncType: SyncType) => {
      if (!nextMonth) return;
      setLoadingTasks(true);
      try {
        const query = buildSyncTaskQuery(nextMonth, nextSyncType, nextPage, nextPageSize);
        const payload = await apiClient.request<SyncTaskListPayload>(`/sync-tasks?${query}`);
        setTasks(payload.items);
        setTasksTotal(payload.total);
        setPage(payload.page);
        setPageSize(payload.pageSize);
      } catch (error) {
        messageApi.error(errorMessage(error));
      } finally {
        setLoadingTasks(false);
      }
    },
    [messageApi],
  );

  const loadAutoExecutionStatus = useCallback(async () => {
    try {
      setAutoExecutionStatus(await apiClient.request<AutoExecutionStatus>('/sync-auto-execution/status'));
    } catch (error) {
      messageApi.error(errorMessage(error));
    }
  }, [messageApi]);

  const loadOperations = useCallback(async () => {
    setLoadingOperations(true);
    try {
      const params = new URLSearchParams({ settlementMonth, page: '1', pageSize: '50' });
      if (operationStatusFilter) params.set('status', operationStatusFilter);
      if (operationTriggerFilter) params.set('triggerType', operationTriggerFilter);
      if (operationAbnormalOnly) params.set('abnormalOnly', 'true');
      const payload = await apiClient.request<SyncOperationListPayload>(`/sync-tasks/operations?${params.toString()}`);
      setOperationTasks(payload.items);
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setLoadingOperations(false);
    }
  }, [messageApi, operationAbnormalOnly, operationStatusFilter, operationTriggerFilter, settlementMonth]);

  const loadOperationDetail = useCallback(async (taskId: string) => {
    setLoadingOperationDetail(true);
    try {
      setOperationDetail(await apiClient.request<SyncOperationDetail>(`/sync-tasks/${taskId}/operation-detail`));
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setLoadingOperationDetail(false);
    }
  }, [messageApi]);

  useEffect(() => {
    form.setFieldsValue({ settlementMonth: defaultMonth(), syncType: 'affiliate_income' });
  }, [form]);

  useEffect(() => {
    void loadAffiliateAccounts();
    void loadCredentials();
    void loadAutoExecutionStatus();
  }, [loadAffiliateAccounts, loadAutoExecutionStatus, loadCredentials]);

  useEffect(() => {
    void loadSettlementStatus(settlementMonth);
    setPlanningPreview(null);
  }, [loadSettlementStatus, settlementMonth]);

  useEffect(() => {
    setPage(1);
    void loadTasks(1, pageSize, settlementMonth, syncType);
  }, [loadTasks, pageSize, settlementMonth, syncType]);

  useEffect(() => {
    void loadOperations();
  }, [loadOperations]);

  useEffect(() => {
    if (syncType !== 'affiliate_income') {
      form.setFieldValue('affiliateAccountId', undefined);
    }
  }, [form, syncType]);

  const refreshCurrent = useCallback(async () => {
    await Promise.all([
      loadTasks(page, pageSize, settlementMonth, syncType),
      loadCredentials(),
      loadSettlementStatus(settlementMonth),
      loadAutoExecutionStatus(),
      loadOperations(),
    ]);
  }, [loadAutoExecutionStatus, loadCredentials, loadOperations, loadSettlementStatus, loadTasks, page, pageSize, settlementMonth, syncType]);

  const executeTask = useCallback(
    (record: SyncTaskRecord) => {
      const taskId = record.taskId || record.id;
      if (!taskId) {
        messageApi.error('任务 ID 缺失，无法执行。');
        return;
      }
      if (!canExecuteStatus(record.status)) return;

      modalApi.confirm({
        title: '确认执行同步任务？',
        content: (
          <Space direction="vertical" size={4}>
            <Typography.Text>结算月份：{record.settlementMonth ?? settlementMonth}</Typography.Text>
            <Typography.Text>平台/服务商：{taskPlatformOrProvider(record)}</Typography.Text>
            <Typography.Text>联盟账号或 provider：{taskSubject(record)}</Typography.Text>
          </Space>
        ),
        okText: '执行',
        cancelText: '取消',
        async onOk() {
          setExecutingTaskId(taskId);
          try {
            const result = await apiClient.request<SyncTaskRecord>(`/sync-tasks/${taskId}/execute`, {
              method: 'POST',
            });
            await refreshCurrent();

            if (result.status === 'failed') {
              messageApi.error(result.errorMessage ?? result.message ?? '任务执行失败。');
              return;
            }
            if (result.status === 'completed') {
              messageApi.success(`任务执行完成：成功 ${result.successCount ?? 0}，失败 ${result.failedCount ?? 0}`);
              return;
            }
            messageApi.info(result.message ?? '任务执行请求已返回。');
          } catch (error) {
            messageApi.error(errorMessage(error));
            await loadTasks(page, pageSize, settlementMonth, syncType);
          } finally {
            setExecutingTaskId(null);
          }
        },
      });
    },
    [canExecuteTask, loadTasks, messageApi, modalApi, page, pageSize, refreshCurrent, settlementMonth, syncType],
  );

  const requestRetry = useCallback((record: SyncOperationRecord) => {
    const taskId = record.taskId || record.id;
    if (!taskId || !canRequestRetryStatus(record.status)) return;
    modalApi.confirm({
      title: '确认请求重试？',
      content: (
        <Space direction="vertical" size={4}>
          <Typography.Text>任务：{taskId}</Typography.Text>
          <Typography.Text>状态：{statusText(record.status)}</Typography.Text>
          <Typography.Text>说明：仅将任务恢复为 pending，不会在页面上立即调用外部 API。</Typography.Text>
        </Space>
      ),
      okText: '请求重试',
      cancelText: '取消',
      async onOk() {
        setOperationActionTaskId(taskId);
        try {
          await apiClient.request(`/sync-tasks/${taskId}/request-retry`, {
            method: 'POST',
            body: JSON.stringify({ reason: 'manual operation console retry' }),
          });
          messageApi.success('已请求重试，任务已恢复为 pending。');
          await refreshCurrent();
          await loadOperations();
        } catch (error) {
          messageApi.error(errorMessage(error));
        } finally {
          setOperationActionTaskId(null);
        }
      },
    });
  }, [loadOperations, messageApi, modalApi, refreshCurrent]);

  const cancelOperationTask = useCallback((record: SyncOperationRecord) => {
    const taskId = record.taskId || record.id;
    if (!taskId || !canCancelOperation(record)) return;
    modalApi.confirm({
      title: '确认取消同步任务？',
      content: (
        <Space direction="vertical" size={4}>
          <Typography.Text>任务：{taskId}</Typography.Text>
          <Typography.Text>状态：{statusText(record.status)}</Typography.Text>
          <Typography.Text>说明：取消只阻止尚未执行或租约已过期的任务，不会中断正在进行的第三方请求。</Typography.Text>
        </Space>
      ),
      okText: '确认取消',
      cancelText: '返回',
      async onOk() {
        setOperationActionTaskId(taskId);
        try {
          await apiClient.request(`/sync-tasks/${taskId}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ reason: 'manual operation console cancel' }),
          });
          messageApi.success('同步任务已取消。');
          await refreshCurrent();
          await loadOperations();
        } catch (error) {
          messageApi.error(errorMessage(error));
        } finally {
          setOperationActionTaskId(null);
        }
      },
    });
  }, [loadOperations, messageApi, modalApi, refreshCurrent]);

  const operationColumns = useMemo<ColumnsType<SyncOperationRecord>>(
    () => [
      { title: 'taskId', dataIndex: 'taskId', width: 220 },
      { title: 'settlementMonth', dataIndex: 'settlementMonth', width: 130 },
      { title: 'sourceType', dataIndex: 'sourceType', width: 150 },
      { title: 'platform/provider', width: 160, render: (_, record) => taskPlatformOrProvider(record) },
      { title: 'triggerType', dataIndex: 'triggerType', width: 120 },
      { title: 'status', dataIndex: 'status', width: 120, render: (value: string) => <Tag color={statusColor(value)}>{statusText(value)}</Tag> },
      { title: 'attempt', width: 110, render: (_, record) => `${record.attemptCount ?? 0}/${record.maxAttempts ?? autoExecutionStatus?.maxAttempts ?? '-'}` },
      { title: 'lastAttemptAt', dataIndex: 'lastAttemptAt', width: 170, render: formatTime },
      { title: 'nextAttemptAt', dataIndex: 'nextAttemptAt', width: 170, render: formatTime },
      { title: 'errorCategory', dataIndex: 'lastErrorCategory', width: 170, render: (value) => value ?? '-' },
      { title: 'lease', dataIndex: 'leaseState', width: 120, render: leaseStateText },
      { title: 'updatedAt', dataIndex: 'updatedAt', width: 170, render: formatTime },
      {
        title: '操作',
        key: 'operation',
        fixed: 'right',
        width: 220,
        render: (_, record) => {
          const taskId = record.taskId || record.id;
          const permitted = canExecuteTask(record);
          return (
            <Space>
              <Button size="small" onClick={() => taskId ? void loadOperationDetail(taskId) : undefined}>详情</Button>
              <Button
                size="small"
                disabled={!permitted || !canRequestRetryStatus(record.status)}
                loading={operationActionTaskId === taskId}
                onClick={() => requestRetry(record)}
              >
                请求重试
              </Button>
              <Button
                size="small"
                danger
                disabled={!permitted || !canCancelOperation(record)}
                loading={operationActionTaskId === taskId}
                onClick={() => cancelOperationTask(record)}
              >
                取消
              </Button>
            </Space>
          );
        },
      },
    ],
    [autoExecutionStatus?.maxAttempts, canExecuteTask, cancelOperationTask, loadOperationDetail, operationActionTaskId, requestRetry],
  );

  const columns = useMemo<ColumnsType<SyncTaskRecord>>(
    () => [
      { title: 'taskId', dataIndex: 'taskId', key: 'taskId', width: 220 },
      { title: 'settlementMonth', dataIndex: 'settlementMonth', key: 'settlementMonth', width: 140 },
      { title: 'sourceType', dataIndex: 'sourceType', key: 'sourceType', width: 150, render: (value) => value ?? '-' },
      { title: 'taskType', dataIndex: 'taskType', key: 'taskType', width: 150 },
      { title: 'platform', dataIndex: 'platform', key: 'platform', width: 120, render: (value) => value ?? '-' },
      { title: 'provider', dataIndex: 'provider', key: 'provider', width: 120, render: (value) => value ?? '-' },
      {
        title: 'affiliateAccountName / affiliateAccountId',
        key: 'affiliateAccount',
        width: 300,
        render: (_, record) => {
          if (record.affiliateAccount) return accountLabel(record.affiliateAccount);
          return record.affiliateAccountId ?? '-';
        },
      },
      {
        title: '凭证状态',
        key: 'credential',
        width: 160,
        render: (_, record) => {
          const credentialKey = taskCredentialKey(record);
          const text = credentialText(credentialKey ? credentialMap[credentialKey] : undefined);
          return <Tag color={text === '已配置凭证' ? 'green' : undefined}>{text}</Tag>;
        },
      },
      {
        title: 'status',
        dataIndex: 'status',
        key: 'status',
        width: 150,
        render: (value: string) => <Tag color={statusColor(value)}>{statusText(value)}</Tag>,
      },
      { title: 'successCount', dataIndex: 'successCount', key: 'successCount', width: 120, render: countText },
      { title: 'failedCount', dataIndex: 'failedCount', key: 'failedCount', width: 120, render: countText },
      { title: '执行方式', dataIndex: 'triggerType', key: 'triggerType', width: 110, render: (value) => value === 'scheduled' ? '规划自动任务' : '人工任务' },
      { title: '尝试次数', dataIndex: 'attemptCount', key: 'attemptCount', width: 100, render: countText },
      { title: '错误分类', dataIndex: 'lastErrorCategory', key: 'lastErrorCategory', width: 180, render: (value) => value ?? '-' },
      { title: '下次重试时间', dataIndex: 'nextAttemptAt', key: 'nextAttemptAt', width: 180, render: formatTime },
      { title: '租约状态', key: 'leaseStatus', width: 100, render: (_, record) => record.executing ? '执行中' : '-' },
      {
        title: 'message / errorMessage',
        key: 'message',
        width: 360,
        render: (_, record) => record.errorMessage ?? record.message ?? '-',
      },
      { title: 'createdAt', dataIndex: 'createdAt', key: 'createdAt', width: 180, render: formatTime },
      { title: 'updatedAt', dataIndex: 'updatedAt', key: 'updatedAt', width: 180, render: formatTime },
      { title: 'startedAt', dataIndex: 'startedAt', key: 'startedAt', width: 180, render: formatTime },
      { title: 'finishedAt', dataIndex: 'finishedAt', key: 'finishedAt', width: 180, render: formatTime },
      {
        title: '操作',
        key: 'operation',
        width: 100,
        fixed: 'right',
        render: (_, record) => {
          const taskId = record.taskId || record.id;
          return (
            <Button
              size="small"
              disabled={!taskId || !canExecuteStatus(record.status) || !canExecuteTask(record)}
              loading={executingTaskId === taskId}
              onClick={() => executeTask(record)}
            >
              执行
            </Button>
          );
        },
      },
    ],
    [canExecuteTask, credentialMap, executeTask, executingTaskId],
  );

  const createSyncTask = async () => {
    if (!selectedOption.endpoint) return;
    if (isLocked && selectedOption.affectsSalary) {
      messageApi.warning('该结算月份已锁账，不能发起会影响工资数据的同步。');
      return;
    }

    try {
      await form.validateFields(
        syncType === 'affiliate_income'
          ? ['settlementMonth', 'syncType', 'affiliateAccountId']
          : ['settlementMonth', 'syncType'],
      );
    } catch {
      return;
    }

    const selectedAccount = affiliateAccounts.find((account) => account.id === affiliateAccountId);
    const subject = syncType === 'affiliate_income' && selectedAccount ? accountLabel(selectedAccount) : selectedOption.label;

    modalApi.confirm({
      title: `确认创建${selectedOption.label}任务？`,
      content: (
        <Space direction="vertical" size={4}>
          <Typography.Text>结算月份：{settlementMonth}</Typography.Text>
          <Typography.Text>平台/服务商：{syncType === 'affiliate_income' ? selectedAccount?.platform ?? '-' : selectedOption.label}</Typography.Text>
          <Typography.Text>联盟账号或 provider：{subject}</Typography.Text>
        </Space>
      ),
      okText: '创建同步任务',
      cancelText: '取消',
      async onOk() {
        setCreatingTask(true);
        try {
          const body = syncType === 'affiliate_income' ? { settlementMonth, affiliateAccountId } : { settlementMonth };
          await apiClient.request<SyncTaskRecord>(selectedOption.endpoint!, {
            method: 'POST',
            body: JSON.stringify(body),
          });
          messageApi.success('同步任务已创建。');
          await loadTasks(1, pageSize, settlementMonth, syncType);
        } catch (error) {
          messageApi.error(errorMessage(error));
        } finally {
          setCreatingTask(false);
        }
      },
    });
  };

  const handleTableChange = (pagination: TablePaginationConfig) => {
    const nextPage = pagination.current ?? 1;
    const nextPageSize = pagination.pageSize ?? DEFAULT_PAGE_SIZE;
    void loadTasks(nextPage, nextPageSize, settlementMonth, syncType);
  };

  const generatePlanning = () => {
    if (!planningPreview || planningPreview.locked || planningPreview.summary.creatableCount === 0) return;
    modalApi.confirm({
      title: '确认生成月度待执行任务？',
      content: `将为 ${settlementMonth} 生成 ${planningPreview.summary.creatableCount} 条 pending 任务。这里只生成任务，不会立即执行同步或调用外部 API。`,
      okText: '生成待执行任务', cancelText: '取消',
      async onOk() {
        setGeneratingPlanning(true);
        try {
          const result = await apiClient.request<{ summary: { createdCount: number } }>('/sync-planning/generate', {
            method: 'POST', body: JSON.stringify({ settlementMonth }),
          });
          messageApi.success(`已生成 ${result.summary.createdCount} 条 pending 任务。`);
          await Promise.all([loadPlanningPreview(), loadTasks(1, pageSize, settlementMonth, syncType)]);
        } catch (error) {
          messageApi.error(errorMessage(error));
        } finally {
          setGeneratingPlanning(false);
        }
      },
    });
  };

  return (
    <section className="page-section data-page">
      {messageHolder}
      {modalHolder}
      <div className="data-page-header">
        <div>
          <Typography.Title level={3}>数据同步</Typography.Title>
          <Typography.Text type="secondary">创建、执行并查看联盟收入与虚拟卡花费同步任务。</Typography.Text>
        </div>
        <Space wrap>
          <Button onClick={() => void refreshCurrent()} loading={loadingTasks || loadingCredentials || checkingSettlement}>
            刷新
          </Button>
        </Space>
      </div>

      <section aria-label="月度任务规划" className="data-page-notice">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Typography.Title level={4}>月度任务规划</Typography.Title>
            <Typography.Text type="secondary">预览并批量生成 pending 任务；这里只生成任务，不会立即执行同步或调用外部 API。</Typography.Text>
          </div>
          <Space wrap>
            <Button onClick={() => void loadPlanningPreview()} loading={loadingPlanning}>预览候选任务</Button>
            {canGeneratePlanning ? (
              <Button type="primary" onClick={generatePlanning} loading={generatingPlanning} disabled={!planningPreview || planningPreview.locked || planningPreview.summary.creatableCount === 0}>
                生成待执行任务
              </Button>
            ) : null}
            {planningPreview ? (
              <Typography.Text>候选 {planningPreview.summary.candidateCount}；可创建 {planningPreview.summary.creatableCount}；已存在 {planningPreview.summary.existingCount}；阻塞 {planningPreview.summary.blockedCount}</Typography.Text>
            ) : null}
          </Space>
          {planningPreview?.locked ? <Alert type="error" showIcon message="该结算月份已锁账，所有候选均不可创建。" /> : null}
          {planningPreview ? (
            <Table<PlanningCandidate>
              size="small" pagination={false} rowKey={(row) => `${row.sourceType}:${row.affiliateAccountId ?? row.provider}`}
              dataSource={planningPreview.candidates}
              columns={[
                { title: '来源', dataIndex: 'sourceType' },
                { title: '任务类型', dataIndex: 'taskType' },
                { title: '账号 / Provider', render: (_, row) => row.affiliateAccountName ?? row.provider ?? '-' },
                { title: '平台', render: (_, row) => row.platform ?? row.provider ?? '-' },
                { title: '凭证', render: (_, row) => <Tag color={row.credentialConfigured ? 'green' : 'red'}>{row.credentialConfigured ? '已配置' : '缺少有效凭证'}</Tag> },
                { title: '状态', render: (_, row) => row.canCreate ? <Tag color="green">可创建</Tag> : <Space wrap>{row.blockerCodes.map((code) => <Tag key={code} color="orange">{code}</Tag>)}</Space> },
              ]}
            />
          ) : null}
        </Space>
      </section>

      <section aria-label="自动执行状态" className="data-page-notice">
        <Typography.Title level={4}>自动执行</Typography.Title>
        {autoExecutionStatus?.enabled ? (
          <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
            <Descriptions.Item label="状态">已启用</Descriptions.Item>
            <Descriptions.Item label="可领取 pending">{autoExecutionStatus.pendingEligibleCount}</Descriptions.Item>
            <Descriptions.Item label="等待重试">{autoExecutionStatus.retryWaitingCount}</Descriptions.Item>
            <Descriptions.Item label="最终失败">{autoExecutionStatus.permanentlyFailedCount}</Descriptions.Item>
            <Descriptions.Item label="执行中">{autoExecutionStatus.activeLeaseCount}</Descriptions.Item>
            <Descriptions.Item label="最大尝试次数">{autoExecutionStatus.maxAttempts}</Descriptions.Item>
            <Descriptions.Item label="最近轮询">{formatTime(autoExecutionStatus.lastPollAt)}</Descriptions.Item>
            <Descriptions.Item label="最近领取">{formatTime(autoExecutionStatus.lastClaimAt)}</Descriptions.Item>
          </Descriptions>
        ) : <Alert type="info" showIcon message="自动执行未启用，任务需人工执行" />}
        <Typography.Text type="secondary">规划只负责生成 pending；自动执行仅处理 scheduled 任务；人工执行仍需管理员明确确认。</Typography.Text>
      </section>

      <section aria-label="同步执行运行台" className="data-page-notice">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Typography.Title level={4}>同步执行运行台</Typography.Title>
            <Typography.Text type="secondary">
              查看任务执行状态、异常摘要和人工处置；请求重试只恢复 pending，不会在页面上立即调用外部 API。
            </Typography.Text>
          </div>
          <Space wrap>
            <Select
              allowClear
              placeholder="status"
              style={{ width: 170 }}
              value={operationStatusFilter}
              onChange={setOperationStatusFilter}
              options={['pending', 'retry_wait', 'running', 'completed', 'failed', 'cancelled'].map((value) => ({ value, label: value }))}
            />
            <Select
              allowClear
              placeholder="triggerType"
              style={{ width: 160 }}
              value={operationTriggerFilter}
              onChange={setOperationTriggerFilter}
              options={[{ value: 'scheduled', label: 'scheduled' }, { value: 'manual', label: 'manual' }]}
            />
            <Button type={operationAbnormalOnly ? 'primary' : 'default'} onClick={() => setOperationAbnormalOnly((value) => !value)}>
              仅看异常
            </Button>
            <Button onClick={() => void loadOperations()} loading={loadingOperations}>刷新运行台</Button>
          </Space>
          <Table
            size="small"
            rowKey={(record) => record.taskId || record.id || `${record.taskType}-${record.updatedAt}`}
            columns={operationColumns}
            dataSource={operationTasks}
            loading={loadingOperations}
            pagination={{ pageSize: 10 }}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: '暂无运行台任务' }}
          />
        </Space>
      </section>

      <Drawer title="同步任务处置详情" open={!!operationDetail} onClose={() => setOperationDetail(null)} width={720}>
        {loadingOperationDetail ? <Typography.Text>加载中...</Typography.Text> : null}
        {operationDetail ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions size="small" bordered column={2}>
              <Descriptions.Item label="taskId">{operationDetail.task.taskId}</Descriptions.Item>
              <Descriptions.Item label="settlementMonth">{operationDetail.task.settlementMonth}</Descriptions.Item>
              <Descriptions.Item label="sourceType">{operationDetail.task.sourceType}</Descriptions.Item>
              <Descriptions.Item label="platform/provider">{taskPlatformOrProvider(operationDetail.task)}</Descriptions.Item>
              <Descriptions.Item label="triggerType">{operationDetail.task.triggerType}</Descriptions.Item>
              <Descriptions.Item label="status">{statusText(operationDetail.task.status)}</Descriptions.Item>
              <Descriptions.Item label="attempt">{operationDetail.task.attemptCount ?? 0}/{operationDetail.task.maxAttempts ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="lease">{leaseStateText(operationDetail.task.leaseState)}</Descriptions.Item>
              <Descriptions.Item label="lastErrorCategory">{operationDetail.task.lastErrorCategory ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="nextAttemptAt">{formatTime(operationDetail.task.nextAttemptAt)}</Descriptions.Item>
              <Descriptions.Item label="retryable">{operationDetail.retryable ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="suggestedAction">{operationDetail.suggestedAction}</Descriptions.Item>
              <Descriptions.Item label="safeMessage" span={2}>{operationDetail.task.lastErrorSafeMessage ?? operationDetail.task.message ?? '-'}</Descriptions.Item>
            </Descriptions>
            <Typography.Text strong>最近执行/审计摘要</Typography.Text>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={operationDetail.recentEvents}
              columns={[
                { title: 'action', dataIndex: 'action' },
                { title: 'result', dataIndex: 'result', width: 100 },
                { title: 'failureReason', dataIndex: 'failureReason', render: (value) => value ?? '-' },
                { title: 'createdAt', dataIndex: 'createdAt', render: formatTime },
              ]}
            />
            <Typography.Text strong>安全 result 摘要</Typography.Text>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{operationDetail.task.resultSummary ? safeJsonText(operationDetail.task.resultSummary) : '-'}</pre>
          </Space>
        ) : null}
      </Drawer>

      <Form form={form} layout="inline" className="data-filter">
        <Form.Item name="settlementMonth" label="结算月份" rules={[{ required: true, message: '请选择结算月份' }]}>
          <Input type="month" />
        </Form.Item>
        <Form.Item name="syncType" label="同步类型" rules={[{ required: true, message: '请选择同步类型' }]}>
          <Select style={{ width: 220 }} options={SYNC_OPTIONS.map(({ value, label }) => ({ value, label }))} />
        </Form.Item>
        {syncType === 'affiliate_income' ? (
          <Form.Item name="affiliateAccountId" label="联盟账号" rules={[{ required: true, message: '请选择联盟账号' }]}>
            <Select
              showSearch
              loading={loadingAccounts}
              placeholder="accountName / accountCode / platform"
              optionFilterProp="label"
              style={{ width: 360 }}
              options={affiliateAccounts.map((account) => ({
                value: account.id,
                label: accountLabel(account),
              }))}
            />
          </Form.Item>
        ) : null}
        {canCreateTask ? (
          <Form.Item>
            <Button type="primary" disabled={isLocked && selectedOption.affectsSalary} loading={creatingTask} onClick={createSyncTask}>
              创建同步任务
            </Button>
          </Form.Item>
        ) : null}
      </Form>

      <Space className="sync-status-row" size={12} wrap>
        <Typography.Text>锁账状态：</Typography.Text>
        {settlementStatus === 'locked' ? <Tag color="red">已锁账</Tag> : null}
        {settlementStatus === 'confirmed' ? <Tag color="green">已确认未锁账</Tag> : null}
        {settlementStatus === 'draft' ? <Tag color="blue">草稿未锁账</Tag> : null}
        {settlementStatus === 'none' ? <Tag>未生成结算</Tag> : null}
        {settlementStatus === 'unknown' ? <Tag>未知</Tag> : null}
        {selectedOption.taskType ? <Tag color="geekblue">{selectedOption.taskType}</Tag> : <Tag>全部任务</Tag>}
      </Space>

      {settlementError ? <Alert className="data-page-notice" type="error" showIcon message="锁账状态查询失败" description={settlementError} /> : null}

      {isLocked && selectedOption.affectsSalary ? (
        <Alert
          className="data-page-notice"
          type="error"
          showIcon
          message="该月份已锁账"
          description="会影响工资数据的同步已禁止创建；执行时如果后端返回 MONTH_LOCKED，会直接展示后端 errorMessage。"
        />
      ) : null}

      <Alert className="data-page-notice" type="info" showIcon message={selectedOption.notice} />

      <Typography.Title level={4}>同步任务记录</Typography.Title>
      <Table
        rowKey={(record) => record.taskId || record.id || `${record.taskType}-${record.createdAt}`}
        columns={columns}
        dataSource={tasks}
        loading={loadingTasks}
        scroll={{ x: 'max-content' }}
        pagination={{ current: page, pageSize, total: tasksTotal, showSizeChanger: true }}
        onChange={handleTableChange}
        locale={{ emptyText: '暂无同步任务记录' }}
        expandable={{
          expandedRowRender: (record) => {
            const credentialKey = taskCredentialKey(record);
            const credential = credentialKey ? credentialMap[credentialKey] : undefined;
            return (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Descriptions size="small" bordered column={2}>
                  <Descriptions.Item label="adapterKey">{formatPayloadValue((record.resultPayload as { adapterKey?: unknown } | null)?.adapterKey)}</Descriptions.Item>
                  <Descriptions.Item label="pulledThirdPartyData">
                    {formatPayloadValue((record.resultPayload as { pulledThirdPartyData?: unknown } | null)?.pulledThirdPartyData)}
                  </Descriptions.Item>
                  <Descriptions.Item label="successCount">{countText(record.successCount)}</Descriptions.Item>
                  <Descriptions.Item label="failedCount">{countText(record.failedCount)}</Descriptions.Item>
                  <Descriptions.Item label="requestWindow">
                    {formatPayloadValue((record.resultPayload as { requestWindow?: unknown } | null)?.requestWindow)}
                  </Descriptions.Item>
                  <Descriptions.Item label="settlementWindow">
                    {formatPayloadValue((record.resultPayload as { settlementWindow?: unknown } | null)?.settlementWindow)}
                  </Descriptions.Item>
                  <Descriptions.Item label="settlementDelayDays">
                    {formatPayloadValue((record.resultPayload as { settlementDelayDays?: unknown } | null)?.settlementDelayDays)}
                  </Descriptions.Item>
                  <Descriptions.Item label="everflowRequest">
                    {formatPayloadValue((record.resultPayload as { everflowRequest?: unknown } | null)?.everflowRequest)}
                  </Descriptions.Item>
                  <Descriptions.Item label="cakeRequest">
                    {formatPayloadValue((record.resultPayload as { cakeRequest?: unknown } | null)?.cakeRequest)}
                  </Descriptions.Item>
                  <Descriptions.Item label="凭证状态">{credentialText(credential)}</Descriptions.Item>
                </Descriptions>
                <Typography.Text strong>resultPayload 安全 JSON</Typography.Text>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{record.resultPayload ? safeJsonText(record.resultPayload) : '-'}</pre>
              </Space>
            );
          },
        }}
      />
    </section>
  );
}
