import { Alert, Button, Form, Input, Modal, Space, Table, Tabs, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import { photonPayDefaultFields, type CredentialPayloadField } from './api-credentials-utils';

type CredentialStatus = 'active' | 'disabled' | string;

type AffiliateCredentialRow = {
  affiliateAccountId: string;
  accountName?: string | null;
  accountCode: string;
  platform: string;
  affiliateId?: string | null;
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
  | { type: 'affiliate'; id: string; title: string; platform: string; accountCode: string; maskedPayload?: unknown }
  | { type: 'cardProvider'; id: string; title: string; maskedPayload?: unknown };

type PayloadField = CredentialPayloadField;

type CredentialFormValues = {
  clientId?: string;
  apiKey?: string;
  baseUrl?: string;
  conversionsPath?: string;
  fields?: PayloadField[];
};

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

function publicMaskedValue(value: unknown): string | undefined {
  return typeof value === 'string' && value && !value.includes('*') ? value : undefined;
}

function previousCompleteGmt8Month() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth() - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  return { settlementMonth: start.toISOString().slice(0, 7), startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
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
      if (nextTarget.type === 'affiliate') {
        const masked =
          nextTarget.maskedPayload && typeof nextTarget.maskedPayload === 'object'
            ? (nextTarget.maskedPayload as Record<string, unknown>)
            : {};
        form.setFieldsValue({
          apiKey: '',
          baseUrl: publicMaskedValue(masked.baseUrl),
          conversionsPath: publicMaskedValue(masked.conversionsPath),
        });
      } else {
        form.setFieldsValue(nextTarget.id === 'airwallex'
          ? { clientId: '', apiKey: '', baseUrl: '' }
          : { fields: photonPayDefaultFields() });
      }
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
    const payload =
      target.type === 'affiliate'
        ? {
            apiKey: values.apiKey?.trim() ?? '',
            ...(values.baseUrl?.trim() ? { baseUrl: values.baseUrl.trim() } : {}),
            ...(target.platform === 'cake' && values.conversionsPath?.trim()
              ? { conversionsPath: values.conversionsPath.trim() }
              : {}),
          }
        : target.id === 'airwallex'
          ? {
              clientId: values.clientId?.trim() ?? '',
              apiKey: values.apiKey?.trim() ?? '',
              ...(values.baseUrl?.trim() ? { baseUrl: values.baseUrl.trim() } : {}),
            }
          : normalizePayloadFields(values);
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
      if (target.type === 'affiliate' && (target.platform === 'cake' || target.platform === 'everflow')) {
        const range = previousCompleteGmt8Month();
        try {
          const summary = await apiClient.request<Record<string, unknown>>(
            `/sync-tasks/${target.platform}-calibration/${target.id}`,
            {
              method: 'POST',
              body: JSON.stringify(range),
            },
          );
          modalApi.info({
            title: `${target.platform === 'cake' ? 'CAKE' : 'Everflow'} 上月 SUB 收入只读校准`,
            width: 720,
            content: (
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto' }}>
                {JSON.stringify(summary, null, 2)}
              </pre>
            ),
          });
        } catch (error) {
          messageApi.warning(`凭证已保存，但上月 SUB 收入只读校准失败：${errorMessage(error)}`);
        }
      }
      closeCredentialModal();
      await refreshAll();
    } catch (error) {
      messageApi.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const calibrateAffiliate = useCallback(async (record: AffiliateCredentialRow) => {
    try {
      const summary = await apiClient.request<Record<string, unknown>>(
        `/sync-tasks/${record.platform}-calibration/${record.affiliateAccountId}`,
        { method: 'POST', body: JSON.stringify(previousCompleteGmt8Month()) },
      );
      modalApi.info({
        title: `${record.platform === 'cake' ? 'CAKE' : 'Everflow'} 上月 SUB 收入只读校准`,
        width: 720,
        content: <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto' }}>{JSON.stringify(summary, null, 2)}</pre>,
      });
    } catch (error) {
      messageApi.error(errorMessage(error));
    }
  }, [messageApi, modalApi]);

  const affiliateColumns = useMemo<ColumnsType<AffiliateCredentialRow>>(
    () => [
      { title: '联盟账号名称', dataIndex: 'accountName', key: 'accountName', render: (value) => value || '-' },
      { title: 'Affiliate ID/账号编码', dataIndex: 'accountCode', key: 'accountCode' },
      { title: '平台', dataIndex: 'platform', key: 'platform', render: (value) => value === 'cake' ? 'CAKE' : value === 'everflow' ? 'Everflow' : value },
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
                  openCredentialModal({
                    type: 'affiliate',
                    id: record.affiliateAccountId,
                    title,
                    platform: record.platform,
                    accountCode: record.accountCode,
                    maskedPayload: record.maskedPayload,
                  })
                }
              >
                {record.hasCredential ? '更新凭证' : '配置凭证'}
              </Button>
              <Button
                size="small"
                disabled={!record.hasCredential || record.status === 'disabled' || !['cake', 'everflow'].includes(record.platform)}
                onClick={() => void calibrateAffiliate(record)}
              >
                校准上月 SUB 收入
              </Button>
              <Button
                danger
                size="small"
                disabled={!record.hasCredential || record.status === 'disabled'}
                onClick={() =>
                  disableCredential({
                    type: 'affiliate',
                    id: record.affiliateAccountId,
                    title,
                    platform: record.platform,
                    accountCode: record.accountCode,
                  })
                }
              >
                禁用凭证
              </Button>
            </Space>
          );
        },
      },
    ],
    [calibrateAffiliate, disableCredential, openCredentialModal],
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
              onClick={() => openCredentialModal({ type: 'cardProvider', id: record.provider, title: record.provider, maskedPayload: record.maskedPayload })}
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
          {target?.type === 'affiliate' ? (
            <>
              {target.platform === 'cake' ? (
                <>
                  <Alert
                    type="info"
                    showIcon
                    message="Affiliate ID 只读"
                    description="CAKE 请求中的 affiliate_id 直接来自联盟账号 accountCode，不在凭证中重复保存。"
                    style={{ marginBottom: 16 }}
                  />
                  <Form.Item label="Affiliate ID">
                    <Input value={target.accountCode} readOnly />
                  </Form.Item>
                </>
              ) : null}
              <Form.Item
                name="apiKey"
                label="API Key"
                rules={[{ required: true, whitespace: true, message: '请填写 API Key' }]}
              >
                <Input.Password autoComplete="new-password" placeholder="安全输入新的 API Key" />
              </Form.Item>
              <Form.Item
                name="baseUrl"
                label="API Base URL"
                rules={target.platform === 'cake' ? [{ required: true, whitespace: true, message: '请填写 API Base URL' }] : []}
                extra={target.platform === 'everflow' ? '可留空，使用 Everflow 官方默认地址。' : '例如 https://affiliates.blitzadsgroup.com/affiliates/api'}
              >
                <Input autoComplete="url" placeholder={target.platform === 'cake' ? 'https://.../affiliates/api' : 'https://api.eflow.team'} />
              </Form.Item>
              {target.platform === 'cake' ? (
                <Form.Item
                  name="conversionsPath"
                  label="Conversions Path（高级，可选）"
                  extra="默认 Reports/Conversions；仅在供应商端点不同且已核实时修改。"
                >
                  <Input placeholder="Reports/Conversions" />
                </Form.Item>
              ) : null}
            </>
          ) : target?.id === 'airwallex' ? (
            <>
              <Alert
                type="info"
                showIcon
                message="Airwallex 管理 API 凭证"
                description="配置一次后，系统会读取账户下全部卡片和清算交易。API Key 仅加密保存；更新凭证时需重新完整输入 Client ID 和 API Key。"
                style={{ marginBottom: 16 }}
              />
              <Form.Item
                name="clientId"
                label="Client ID"
                rules={[{ required: true, whitespace: true, message: '请填写 Airwallex Client ID' }]}
              >
                <Input autoComplete="off" placeholder="Airwallex Client ID" />
              </Form.Item>
              <Form.Item
                name="apiKey"
                label="API Key"
                rules={[{ required: true, whitespace: true, message: '请填写 Airwallex API Key' }]}
              >
                <Input.Password autoComplete="new-password" placeholder="安全输入 Airwallex API Key" />
              </Form.Item>
              <Form.Item
                name="baseUrl"
                label="API Base URL（高级，可选）"
                extra="留空使用 Airwallex 官方生产地址 https://api.airwallex.com。"
              >
                <Input autoComplete="url" placeholder="https://api.airwallex.com" />
              </Form.Item>
            </>
          ) : (
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
          )}
        </Form>
      </Modal>
    </section>
  );
}
