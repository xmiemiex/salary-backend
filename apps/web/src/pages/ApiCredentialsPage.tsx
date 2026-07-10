import { Button, Form, Input, Modal, Space, Table, Tabs, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';

type CredentialStatus = 'active' | 'disabled' | string;

type AffiliateCredentialRow = {
  affiliateAccountId: string;
  accountName?: string | null;
  accountCode: string;
  platform: string;
  hasCredential: boolean;
  status?: CredentialStatus | null;
  maskedPayload?: unknown;
  updatedAt?: string | null;
};

type CardProviderCredentialRow = {
  provider: 'airwallex' | 'photonpay';
  hasCredential: boolean;
  status?: CredentialStatus | null;
  maskedPayload?: unknown;
  updatedAt?: string | null;
};

type CredentialTarget =
  | { type: 'affiliate'; id: string; title: string }
  | { type: 'cardProvider'; id: string; title: string };

type PayloadField = {
  key?: string;
  value?: string;
};

type CredentialFormValues = {
  fields?: PayloadField[];
};

const DEFAULT_FIELDS: PayloadField[] = [{ key: '', value: '' }];

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '请求失败，请稍后重试。';
}

function formatTime(value: unknown): string {
  if (typeof value !== 'string' || !value) return '-';
  return value.replace('T', ' ').slice(0, 19);
}

function formatPayload(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function statusColor(status: unknown): string {
  if (status === 'active') return 'green';
  if (status === 'disabled') return 'default';
  return 'blue';
}

function statusText(status: unknown): string {
  if (status === 'active') return '启用';
  if (status === 'disabled') return '禁用';
  return typeof status === 'string' && status ? status : '-';
}

function credentialLabel(hasCredential: boolean): JSX.Element {
  return hasCredential ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>;
}

function normalizePayloadFields(values: CredentialFormValues): Record<string, string> {
  const result: Record<string, string> = {};
  const fields = values.fields ?? [];
  fields.forEach((field) => {
    const key = field.key?.trim();
    if (!key) return;
    result[key] = field.value ?? '';
  });
  return result;
}

export function ApiCredentialsPage() {
  const [messageApi, messageHolder] = message.useMessage();
  const [modalApi, modalHolder] = Modal.useModal();
  const [form] = Form.useForm<CredentialFormValues>();
  const [affiliateRows, setAffiliateRows] = useState<AffiliateCredentialRow[]>([]);
  const [cardProviderRows, setCardProviderRows] = useState<CardProviderCredentialRow[]>([]);
  const [loadingAffiliate, setLoadingAffiliate] = useState(false);
  const [loadingCardProviders, setLoadingCardProviders] = useState(false);
  const [saving, setSaving] = useState(false);
  const [target, setTarget] = useState<CredentialTarget | null>(null);

  const loadAffiliateRows = useCallback(async () => {
    setLoadingAffiliate(true);
    try {
      const rows = await apiClient.request<AffiliateCredentialRow[]>('/api-credentials/affiliate-accounts');
      setAffiliateRows(rows);
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setLoadingAffiliate(false);
    }
  }, [messageApi]);

  const loadCardProviderRows = useCallback(async () => {
    setLoadingCardProviders(true);
    try {
      const rows = await apiClient.request<CardProviderCredentialRow[]>('/api-credentials/card-providers');
      setCardProviderRows(rows);
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setLoadingCardProviders(false);
    }
  }, [messageApi]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadAffiliateRows(), loadCardProviderRows()]);
  }, [loadAffiliateRows, loadCardProviderRows]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const openCredentialModal = useCallback(
    (nextTarget: CredentialTarget) => {
      form.resetFields();
      form.setFieldsValue({ fields: DEFAULT_FIELDS });
      setTarget(nextTarget);
    },
    [form],
  );

  const closeCredentialModal = useCallback(() => {
    setTarget(null);
    form.resetFields();
  }, [form]);

  const disableCredential = useCallback(
    (nextTarget: CredentialTarget) => {
      modalApi.confirm({
        title: '确认禁用凭证？',
        content: `禁用后该配置将不再作为有效凭证使用。对象：${nextTarget.title}`,
        okText: '确认禁用',
        okButtonProps: { danger: true },
        cancelText: '取消',
        async onOk() {
          try {
            const endpoint =
              nextTarget.type === 'affiliate'
                ? `/api-credentials/affiliate-accounts/${nextTarget.id}/disable`
                : `/api-credentials/card-providers/${nextTarget.id}/disable`;
            await apiClient.request(endpoint, { method: 'PATCH' });
            await refreshAll();
          } catch (error) {
            messageApi.error(errorMessage(error));
          }
        },
      });
    },
    [messageApi, modalApi, refreshAll],
  );

  const submitCredential = async () => {
    if (!target) return;
    const values = await form.validateFields();
    const payload = normalizePayloadFields(values);
    if (Object.keys(payload).length === 0) {
      messageApi.error('请至少填写一个 payload 字段。');
      return;
    }

    setSaving(true);
    try {
      const endpoint =
        target.type === 'affiliate'
          ? `/api-credentials/affiliate-accounts/${target.id}`
          : `/api-credentials/card-providers/${target.id}`;
      await apiClient.request(endpoint, {
        method: 'PUT',
        body: JSON.stringify({ payload }),
      });
      messageApi.success('凭证已保存');
      closeCredentialModal();
      await refreshAll();
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const affiliateColumns = useMemo<ColumnsType<AffiliateCredentialRow>>(
    () => [
      { title: 'accountName', dataIndex: 'accountName', key: 'accountName', render: (value) => value || '-' },
      { title: 'accountCode', dataIndex: 'accountCode', key: 'accountCode' },
      { title: 'platform', dataIndex: 'platform', key: 'platform' },
      {
        title: 'hasCredential',
        dataIndex: 'hasCredential',
        key: 'hasCredential',
        render: (value: boolean) => credentialLabel(value),
      },
      {
        title: 'status',
        dataIndex: 'status',
        key: 'status',
        render: (value) => <Tag color={statusColor(value)}>{statusText(value)}</Tag>,
      },
      {
        title: 'maskedPayload',
        dataIndex: 'maskedPayload',
        key: 'maskedPayload',
        width: 320,
        render: formatPayload,
      },
      { title: 'updatedAt', dataIndex: 'updatedAt', key: 'updatedAt', render: formatTime },
      {
        title: '操作',
        key: 'actions',
        fixed: 'right',
        render: (_, record) => {
          const title = `${record.accountName || record.accountCode} / ${record.platform}`;
          return (
            <Space>
              <Button
                size="small"
                onClick={() =>
                  openCredentialModal({ type: 'affiliate', id: record.affiliateAccountId, title })
                }
              >
                {record.hasCredential ? '更新凭证' : '配置凭证'}
              </Button>
              <Button
                danger
                size="small"
                disabled={!record.hasCredential || record.status === 'disabled'}
                onClick={() => disableCredential({ type: 'affiliate', id: record.affiliateAccountId, title })}
              >
                禁用凭证
              </Button>
            </Space>
          );
        },
      },
    ],
    [disableCredential, openCredentialModal],
  );

  const cardProviderColumns = useMemo<ColumnsType<CardProviderCredentialRow>>(
    () => [
      { title: 'provider', dataIndex: 'provider', key: 'provider' },
      {
        title: 'hasCredential',
        dataIndex: 'hasCredential',
        key: 'hasCredential',
        render: (value: boolean) => credentialLabel(value),
      },
      {
        title: 'status',
        dataIndex: 'status',
        key: 'status',
        render: (value) => <Tag color={statusColor(value)}>{statusText(value)}</Tag>,
      },
      {
        title: 'maskedPayload',
        dataIndex: 'maskedPayload',
        key: 'maskedPayload',
        width: 320,
        render: formatPayload,
      },
      { title: 'updatedAt', dataIndex: 'updatedAt', key: 'updatedAt', render: formatTime },
      {
        title: '操作',
        key: 'actions',
        fixed: 'right',
        render: (_, record) => (
          <Space>
            <Button
              size="small"
              onClick={() => openCredentialModal({ type: 'cardProvider', id: record.provider, title: record.provider })}
            >
              {record.hasCredential ? '更新凭证' : '配置凭证'}
            </Button>
            <Button
              danger
              size="small"
              disabled={!record.hasCredential || record.status === 'disabled'}
              onClick={() => disableCredential({ type: 'cardProvider', id: record.provider, title: record.provider })}
            >
              禁用凭证
            </Button>
          </Space>
        ),
      },
    ],
    [disableCredential, openCredentialModal],
  );

  return (
    <section className="page-section data-page">
      {messageHolder}
      {modalHolder}
      <div className="data-page-header">
        <Typography.Title level={3}>API 凭证配置</Typography.Title>
        <Button onClick={() => void refreshAll()} loading={loadingAffiliate || loadingCardProviders}>
          刷新
        </Button>
      </div>

      <Tabs
        items={[
          {
            key: 'affiliate-accounts',
            label: '联盟账号凭证',
            children: (
              <Table
                rowKey="affiliateAccountId"
                columns={affiliateColumns}
                dataSource={affiliateRows}
                loading={loadingAffiliate}
                scroll={{ x: 'max-content' }}
              />
            ),
          },
          {
            key: 'card-providers',
            label: '虚拟卡平台凭证',
            children: (
              <Table
                rowKey="provider"
                columns={cardProviderColumns}
                dataSource={cardProviderRows}
                loading={loadingCardProviders}
                scroll={{ x: 'max-content' }}
              />
            ),
          },
        ]}
      />

      <Modal
        title={target ? `配置凭证：${target.title}` : '配置凭证'}
        open={Boolean(target)}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={720}
        destroyOnClose
        onOk={() => void submitCredential()}
        onCancel={closeCredentialModal}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.List
            name="fields"
            rules={[
              {
                validator: async (_, fields: PayloadField[] | undefined) => {
                  const valid = fields?.some((field) => field?.key?.trim());
                  if (!valid) throw new Error('请至少填写一个 payload 字段。');
                },
              },
            ]}
          >
            {(fields, { add, remove }, { errors }) => (
              <div className="credential-field-list">
                {fields.map((field) => (
                  <Space key={field.key} className="credential-field-row" align="baseline">
                    <Form.Item
                      {...field}
                      name={[field.name, 'key']}
                      label="key"
                      rules={[{ required: true, whitespace: true, message: '请填写 key' }]}
                    >
                      <Input placeholder="key" />
                    </Form.Item>
                    <Form.Item {...field} name={[field.name, 'value']} label="value">
                      <Input.Password placeholder="value" autoComplete="new-password" />
                    </Form.Item>
                    <Button danger disabled={fields.length <= 1} onClick={() => remove(field.name)}>
                      删除
                    </Button>
                  </Space>
                ))}
                <Button onClick={() => add({ key: '', value: '' })}>增加字段</Button>
                <Form.ErrorList errors={errors} />
              </div>
            )}
          </Form.List>
        </Form>
      </Modal>
    </section>
  );
}
