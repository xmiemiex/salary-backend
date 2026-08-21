import { Alert, Button, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { getStoredActor } from '../lib/auth-storage';

type CardRow = {
  id: string;
  provider: 'airwallex' | 'photonpay';
  maskedCardNumber?: string | null;
  nickname?: string | null;
  providerStatus?: string | null;
  cardholderEmail?: string | null;
  matchStatus: 'matched' | 'unmatched' | 'conflict' | 'excluded';
};

type Group = {
  groupKey: string;
  cardholderEmail: string;
  maskedEmail: string;
  cardCount: number;
  statusCounts: Record<string, number>;
};

type Employee = { id: string; employeeCode: string; name: string; status: string };
type Alias = {
  id: string;
  aliasEmail: string;
  maskedEmail: string;
  employee: Employee;
  status: string;
  validFrom: string;
  validTo?: string | null;
  reason?: string | null;
};
type Exclusion = {
  id: string;
  status: string;
  reason: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  providerCard: Pick<CardRow, 'id' | 'provider' | 'maskedCardNumber' | 'nickname' | 'providerStatus'>;
};

type RematchResult = {
  matchedByPrimaryEmail: number;
  matchedByAlias: number;
  excluded: number;
  remainingUnmatched: number;
  conflict: number;
  employeeDisabled: number;
  employeeWithoutSub: number;
  missingId: number;
  resolvedExceptionCount: number;
};

type AliasEditor = {
  employeeId: string;
  validFrom?: string;
  validTo?: string;
  reason?: string;
};

export function PhotonPayCardGovernancePanel({ cards, onChanged }: { cards: CardRow[]; onChanged: () => Promise<void> }) {
  const actor = getStoredActor();
  const permissions = new Set(actor?.permissions ?? []);
  const canRead = permissions.has('photonpay_unmatched.read');
  const canManageAliases = permissions.has('photonpay_email_alias.manage');
  const canRematch = permissions.has('photonpay_rematch.execute');
  const canExclude = permissions.has('provider_card_exclusion.manage');
  const [groups, setGroups] = useState<Group[]>([]);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [exclusions, setExclusions] = useState<Exclusion[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [editingAlias, setEditingAlias] = useState<Alias | null>(null);
  const [aliasForm] = Form.useForm<AliasEditor>();
  const [messageApi, holder] = message.useMessage();
  const [modalApi, modalHolder] = Modal.useModal();

  const load = useCallback(async () => {
    if (!canRead && !canManageAliases && !canExclude) return;
    setLoading(true);
    try {
      const requests: Promise<unknown>[] = [canManageAliases
        ? apiClient.request<Employee[]>('/card-bindings/photonpay/employee-options')
        : Promise.resolve([])];
      if (canRead) requests.push(apiClient.request<{ groups: Group[] }>('/card-bindings/photonpay/unmatched-groups'));
      if (canManageAliases) requests.push(apiClient.request<{ items: Alias[] }>('/card-bindings/photonpay/aliases'));
      if (canExclude) requests.push(apiClient.request<{ items: Exclusion[] }>('/card-bindings/photonpay/exclusions'));
      const results = await Promise.all(requests);
      setEmployees(results[0] as Employee[]);
      let index = 1;
      if (canRead) setGroups((results[index++] as { groups: Group[] }).groups);
      if (canManageAliases) setAliases((results[index++] as { items: Alias[] }).items);
      if (canExclude) setExclusions((results[index++] as { items: Exclusion[] }).items);
    } catch (error) {
      messageApi.error(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [canExclude, canManageAliases, canRead, messageApi]);

  useEffect(() => { void load(); }, [load]);

  const employeeOptions = useMemo(() => employees.map((employee) => ({
    value: employee.id,
    label: `${employee.employeeCode} ${employee.name}`,
  })), [employees]);

  const openAlias = (group: Group) => {
    setEditingAlias(null);
    setSelectedGroup(group);
    aliasForm.resetFields();
  };

  const openCorrection = (alias: Alias) => {
    setSelectedGroup(null);
    setEditingAlias(alias);
    aliasForm.setFieldsValue({
      employeeId: alias.employee.id,
      validFrom: toLocalInput(alias.validFrom),
      validTo: alias.validTo ? toLocalInput(alias.validTo) : undefined,
      reason: alias.reason ?? undefined,
    });
  };

  const saveAlias = async () => {
    const values = await aliasForm.validateFields();
    setSaving(true);
    try {
      if (editingAlias) {
        const payload = normalizeAliasDates(values);
        const preview = await apiClient.request<{
          affectedCardCount: number;
          targetEmployee: Employee;
          currentSubMappingActive: boolean;
          conflict: boolean;
          blockers: string[];
          idempotent: boolean;
        }>(`/card-bindings/photonpay/aliases/${editingAlias.id}/preview`, {
          method: 'POST', body: JSON.stringify(payload),
        });
        modalApi.confirm({
          title: '确认更正 PhotonPay 邮箱别名？',
          content: (
            <Space direction="vertical">
              <span>影响卡片：{preview.affectedCardCount}</span>
              <span>目标员工：{preview.targetEmployee.employeeCode} {preview.targetEmployee.name}</span>
              <span>当前有效 SUB：{preview.currentSubMappingActive ? '是' : '否'}</span>
              <span>冲突：{preview.conflict ? preview.blockers.join(', ') : '无'}</span>
              <span>幂等操作：{preview.idempotent ? '是（不写入重复审计）' : '否'}</span>
              <span>系统会保留原审计并重新评估受影响卡片，不会补拉历史交易。</span>
            </Space>
          ),
          okText: '确认更正',
          okButtonProps: { disabled: preview.conflict },
          cancelText: '取消',
          onOk: async () => {
            await apiClient.request(`/card-bindings/photonpay/aliases/${editingAlias.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ ...payload, confirm: true }),
            });
            messageApi.success('别名已更正并重新匹配');
            setEditingAlias(null);
            await Promise.all([load(), onChanged()]);
          },
        });
        return;
      }
      if (!selectedGroup) return;
      const payload = { groupKey: selectedGroup.groupKey, ...normalizeAliasDates(values) };
      const preview = await apiClient.request<{
        affectedCardCount: number;
        statusCounts: Record<string, number>;
        targetEmployee: Employee;
        currentSubMappingActive: boolean;
        conflict: boolean;
        blockers: string[];
        idempotent: boolean;
      }>('/card-bindings/photonpay/aliases/preview', { method: 'POST', body: JSON.stringify(payload) });
      modalApi.confirm({
        title: '确认建立 PhotonPay 专属邮箱别名？',
        content: (
          <Space direction="vertical">
            <span>旧邮箱组：{selectedGroup.cardholderEmail}</span>
            <span>影响卡片：{preview.affectedCardCount}；状态：{formatCounts(preview.statusCounts)}</span>
            <span>目标员工：{preview.targetEmployee.employeeCode} {preview.targetEmployee.name}</span>
            <span>当前有效 SUB：{preview.currentSubMappingActive ? '是' : '否'}</span>
            <span>冲突：{preview.conflict ? preview.blockers.join(', ') : '无'}</span>
          </Space>
        ),
        okText: '确认保存并重新匹配',
        okButtonProps: { disabled: preview.conflict },
        cancelText: '取消',
        onOk: async () => {
          await apiClient.request('/card-bindings/photonpay/aliases', {
            method: 'POST',
            body: JSON.stringify({ ...payload, confirm: true }),
          });
          messageApi.success('别名已保存并自动重新匹配');
          setSelectedGroup(null);
          await Promise.all([load(), onChanged()]);
        },
      });
    } catch (error) {
      messageApi.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const disableAlias = async (alias: Alias) => {
    try {
      const preview = await apiClient.request<{ affectedCardCount: number; maskedEmail: string }>(
        `/card-bindings/photonpay/aliases/${alias.id}/disable/preview`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      modalApi.confirm({
        title: '确认禁用 PhotonPay 邮箱别名？',
        content: `别名 ${preview.maskedEmail} 将被禁用，并重新评估 ${preview.affectedCardCount} 张当前依赖该别名的卡；历史归属和审计不会删除，也不会补拉交易。`,
        okText: '确认禁用并重新评估',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          await apiClient.request(`/card-bindings/photonpay/aliases/${alias.id}/disable`, {
            method: 'POST', body: JSON.stringify({ confirm: true }),
          });
          messageApi.success('别名已禁用');
          await Promise.all([load(), onChanged()]);
        },
      });
    } catch (error) {
      messageApi.error(errorText(error));
    }
  };

  const previewAndRematch = async () => {
    try {
      const preview = await apiClient.request<RematchResult>('/card-bindings/photonpay/rematch/preview');
      modalApi.confirm({
        title: '确认重新匹配当前未匹配 PhotonPay 卡？',
        content: <RematchSummary result={preview} />,
        okText: '确认重新匹配',
        cancelText: '取消',
        onOk: async () => {
          const result = await apiClient.request<RematchResult>('/card-bindings/photonpay/rematch', {
            method: 'POST', body: JSON.stringify({ confirm: true }),
          });
          messageApi.success(`重新匹配完成：别名=${result.matchedByAlias}，剩余=${result.remainingUnmatched}，冲突=${result.conflict}`);
          await Promise.all([load(), onChanged()]);
        },
      });
    } catch (error) {
      messageApi.error(errorText(error));
    }
  };

  const excludeCard = async (card: CardRow) => {
    try {
      const preview = await apiClient.request<{
        card: CardRow;
        effectiveFrom: string;
        effectiveTo?: string | null;
        existingCardSpendEventCount: number;
        existingSpendUsd: string;
        existingMonths: Array<{ month: string; count: number }>;
        canApply: boolean;
        blocker: string | null;
      }>('/card-bindings/photonpay/exclusions/preview', {
        method: 'POST', body: JSON.stringify({ providerCardId: card.id }),
      });
      modalApi.confirm({
        title: '确认标记为管理员测试卡并排除记账？',
        content: (
          <Space direction="vertical">
            <span>卡片：{card.maskedCardNumber ?? '-'} / {card.nickname ?? '-'}</span>
            <span>已有 CardSpendEvent：{preview.existingCardSpendEventCount}；安全汇总 USD：{preview.existingSpendUsd}</span>
            <span>涉及月份：{preview.existingMonths.map((item) => `${item.month}(${item.count})`).join(', ') || '无'}</span>
            {preview.blocker ? <Typography.Text type="danger">阻断：{preview.blocker}</Typography.Text> : null}
          </Space>
        ),
        okText: '确认排除记账',
        okButtonProps: { disabled: !preview.canApply, danger: true },
        cancelText: '取消',
        onOk: async () => {
          await apiClient.request('/card-bindings/photonpay/exclusions', {
            method: 'POST', body: JSON.stringify({
              providerCardId: card.id,
              effectiveFrom: preview.effectiveFrom,
              effectiveTo: preview.effectiveTo,
              confirm: true,
            }),
          });
          messageApi.success('已标记为管理员测试卡并排除记账');
          await Promise.all([load(), onChanged()]);
        },
      });
    } catch (error) {
      messageApi.error(errorText(error));
    }
  };

  const disableExclusion = (item: Exclusion) => {
    modalApi.confirm({
      title: '确认取消卡片记账排除？',
      content: '取消后仅重新评估当前卡片归属；系统不会自动补拉或重放历史交易。',
      okText: '确认取消排除',
      cancelText: '保留排除',
      onOk: async () => {
        await apiClient.request(`/card-bindings/photonpay/exclusions/${item.id}/disable`, {
          method: 'POST', body: JSON.stringify({ confirm: true }),
        });
        messageApi.success('排除规则已禁用');
        await Promise.all([load(), onChanged()]);
      },
    });
  };

  if (!canRead && !canManageAliases && !canExclude) return null;

  const groupColumns: ColumnsType<Group> = [
    { title: 'PhotonPay 旧邮箱', dataIndex: 'cardholderEmail' },
    { title: '卡片数', dataIndex: 'cardCount' },
    { title: '状态分布', dataIndex: 'statusCounts', render: (value) => formatCounts(value) },
    { title: '操作', render: (_, group) => <Button size="small" disabled={!canManageAliases || !canRematch} onClick={() => openAlias(group)}>映射到员工</Button> },
  ];
  const aliasColumns: ColumnsType<Alias> = [
    { title: '旧邮箱', dataIndex: 'aliasEmail' },
    { title: '员工', render: (_, alias) => `${alias.employee.employeeCode} ${alias.employee.name}` },
    { title: '有效期', render: (_, alias) => `${formatDate(alias.validFrom)} → ${alias.validTo ? formatDate(alias.validTo) : '长期'}` },
    { title: '状态', dataIndex: 'status', render: (status) => <Tag color={status === 'active' ? 'green' : 'default'}>{status}</Tag> },
    {
      title: '操作', render: (_, alias) => alias.status === 'active' ? <Space>
        <Button size="small" disabled={!canRematch} onClick={() => openCorrection(alias)}>更正</Button>
        <Button danger size="small" disabled={!canRematch} onClick={() => void disableAlias(alias)}>禁用</Button>
      </Space> : '-',
    },
  ];
  const exclusionColumns: ColumnsType<Exclusion> = [
    { title: '卡片', render: (_, item) => `${item.providerCard.maskedCardNumber ?? '-'} ${item.providerCard.nickname ?? ''}`.trim() },
    { title: '原因', dataIndex: 'reason', render: () => '管理员测试卡' },
    { title: '有效期', render: (_, item) => `${formatDate(item.effectiveFrom)} → ${item.effectiveTo ? formatDate(item.effectiveTo) : '长期'}` },
    { title: '状态', dataIndex: 'status' },
    { title: '操作', render: (_, item) => item.status === 'active' ? <Button size="small" onClick={() => disableExclusion(item)}>取消排除</Button> : '-' },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {holder}{modalHolder}
      <Alert type="warning" showIcon message="PhotonPay 历史邮箱映射与测试卡排除均为高风险写操作，保存前必须预览并确认；不会修改员工主邮箱或重放历史交易。" />
      {canRead ? <section>
        <Space wrap style={{ marginBottom: 12 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>PhotonPay 未匹配邮箱组</Typography.Title>
          <Button onClick={() => void load()} loading={loading}>刷新安全清单</Button>
          <Button type="primary" disabled={!canRematch} onClick={() => void previewAndRematch()}>预览并重新匹配</Button>
        </Space>
        <Table rowKey="groupKey" size="small" columns={groupColumns} dataSource={groups} loading={loading} pagination={false} />
      </section> : null}
      {canManageAliases ? <section>
        <Typography.Title level={4}>PhotonPay 邮箱别名</Typography.Title>
        <Table rowKey="id" size="small" columns={aliasColumns} dataSource={aliases} loading={loading} pagination={false} />
      </section> : null}
      {canExclude ? <section>
        <Typography.Title level={4}>管理员测试卡排除</Typography.Title>
        <Space wrap style={{ marginBottom: 12 }}>
          {cards.filter((card) => card.provider === 'photonpay'
            && ['normal', 'active'].includes((card.providerStatus ?? '').toLowerCase())
            && card.matchStatus !== 'excluded').map((card) => (
            <Button key={card.id} size="small" onClick={() => void excludeCard(card)}>
              选择 {card.maskedCardNumber ?? card.nickname ?? '已发现卡片'}
            </Button>
          ))}
        </Space>
        <Table rowKey="id" size="small" columns={exclusionColumns} dataSource={exclusions} loading={loading} pagination={false} />
      </section> : null}
      <Modal
        open={Boolean(selectedGroup || editingAlias)}
        title={editingAlias ? '更正 PhotonPay 邮箱别名' : `映射旧邮箱组 ${selectedGroup?.maskedEmail ?? ''}`}
        onCancel={() => { setSelectedGroup(null); setEditingAlias(null); }}
        onOk={() => void saveAlias()}
        confirmLoading={saving}
        okText="先预览"
        destroyOnClose
      >
        <Form form={aliasForm} layout="vertical">
          <Form.Item name="employeeId" label="目标员工" rules={[{ required: true, message: '请选择员工。' }]}>
            <Select showSearch optionFilterProp="label" options={employeeOptions} placeholder="按员工编码或姓名搜索" />
          </Form.Item>
          <Form.Item name="validFrom" label="生效时间（可选，新建默认立即生效）" rules={editingAlias ? [{ required: true }] : undefined}>
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item name="validTo" label="失效时间（可选）"><Input type="datetime-local" /></Form.Item>
          <Form.Item name="reason" label="创建原因或备注"><Input.TextArea maxLength={2000} /></Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

function RematchSummary({ result }: { result: RematchResult }) {
  return <Space direction="vertical">
    <span>主邮箱匹配：{result.matchedByPrimaryEmail}</span>
    <span>别名匹配：{result.matchedByAlias}</span>
    <span>排除：{result.excluded}</span>
    <span>剩余未匹配：{result.remainingUnmatched}</span>
    <span>冲突：{result.conflict}</span>
    <span>员工停用 / 无有效SUB：{result.employeeDisabled} / {result.employeeWithoutSub}</span>
    <span>缺少稳定ID：{result.missingId}</span>
  </Space>;
}

function normalizeAliasDates(values: AliasEditor) {
  return {
    employeeId: values.employeeId,
    validFrom: values.validFrom ? new Date(values.validFrom).toISOString() : undefined,
    validTo: values.validTo ? new Date(values.validTo).toISOString() : undefined,
    reason: values.reason?.trim() || undefined,
  };
}

function formatCounts(value: Record<string, number>) {
  return Object.entries(value).map(([key, count]) => `${key}: ${count}`).join('；') || '-';
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { hour12: false });
}

function toLocalInput(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : '操作失败';
}
