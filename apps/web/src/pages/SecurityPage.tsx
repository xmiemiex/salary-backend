import { Alert, Button, Card, Descriptions, Form, Input, Modal, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import { containsSensitiveSecurityField, PASSWORD_RULE_MESSAGE, runInvalidatingAction, validatePasswordChange } from './security-utils';

type Role = { id: string; code: string; name: string; status: string };
type SecurityProfile = { username: string; email: string | null; status: string; lastLoginAt: string | null; roles: Role[] };
type AdminSession = {
  id: string; createdAt: string; expiresAt: string; lastUsedAt: string | null;
  ipAddress: string | null; userAgent: string | null; isCurrent: boolean;
};
type PasswordValues = { currentPassword: string; newPassword: string; confirmPassword: string };

export function SecurityPage({ onCurrentSessionInvalidated }: { onCurrentSessionInvalidated: () => void }) {
  const [profile, setProfile] = useState<SecurityProfile | null>(null);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [changing, setChanging] = useState(false);
  const [form] = Form.useForm<PasswordValues>();
  const [messageApi, messageHolder] = message.useMessage();
  const [modalApi, modalHolder] = Modal.useModal();

  const showError = useCallback((error: unknown) => {
    messageApi.error(error instanceof ApiError || error instanceof Error ? error.message : '安全中心操作失败。');
  }, [messageApi]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextProfile, nextSessions] = await Promise.all([
        apiClient.request<SecurityProfile>('/auth/security'),
        apiClient.request<AdminSession[]>('/auth/sessions'),
      ]);
      if (containsSensitiveSecurityField(nextProfile) || containsSensitiveSecurityField(nextSessions)) {
        throw new Error('安全接口返回了敏感字段，页面已拒绝渲染。');
      }
      setProfile(nextProfile);
      setSessions(nextSessions);
    } catch (error) { showError(error); }
    finally { setLoading(false); }
  }, [showError]);

  useEffect(() => { void load(); }, [load]);

  const submitPassword = async () => {
    try {
      const values = await form.validateFields();
      const validation = validatePasswordChange(values);
      if (validation) { messageApi.error(validation); return; }
      setChanging(true);
      await runInvalidatingAction(() => apiClient.changePassword(values), onCurrentSessionInvalidated);
    } catch (error) {
      if (!isFormValidationError(error)) showError(error);
    } finally { setChanging(false); }
  };

  const revoke = (session: AdminSession) => {
    modalApi.confirm({
      title: session.isCurrent ? '撤销当前会话？' : '撤销此登录会话？',
      content: session.isCurrent ? '当前页面将立即退出并返回登录页。' : '对应设备将在后续请求时退出登录。',
      okText: '确认撤销', cancelText: '取消', okButtonProps: { danger: true },
      async onOk() {
        try {
          const result = await apiClient.revokeSession(session.id);
          if (result.currentSessionRevoked) onCurrentSessionInvalidated();
          else { messageApi.success('会话已撤销。'); await load(); }
        } catch (error) { showError(error); }
      },
    });
  };

  const logoutAll = () => {
    modalApi.confirm({
      title: '退出全部设备？',
      content: '包括当前设备在内的全部有效会话将立即失效。',
      okText: '确认全部退出', cancelText: '取消', okButtonProps: { danger: true },
      async onOk() {
        try { await runInvalidatingAction(() => apiClient.logoutAll(), onCurrentSessionInvalidated); }
        catch (error) { showError(error); }
      },
    });
  };

  const columns = useMemo<ColumnsType<AdminSession>>(() => [
    { title: '会话', key: 'current', render: (_, row) => row.isCurrent ? <Tag color="blue">当前会话</Tag> : <Tag>其他会话</Tag> },
    { title: '登录时间', dataIndex: 'createdAt', render: formatTime },
    { title: '最近活动', dataIndex: 'lastUsedAt', render: formatTime },
    { title: '到期时间', dataIndex: 'expiresAt', render: formatTime },
    { title: 'IP', dataIndex: 'ipAddress', render: plainText },
    { title: '浏览器 / 设备', dataIndex: 'userAgent', ellipsis: true, render: plainText },
    { title: '操作', key: 'action', render: (_, row) => <Button danger size="small" onClick={() => revoke(row)}>撤销</Button> },
  ], []);

  return (
    <section className="page-section data-page">
      {messageHolder}{modalHolder}
      <div className="data-page-header">
        <Typography.Title level={3}>个人安全</Typography.Title>
        <Space><Button loading={loading} onClick={() => load()}>刷新</Button><Button danger onClick={logoutAll}>退出全部设备</Button></Space>
      </div>
      <Card title="账号安全信息" loading={loading}>
        <Descriptions column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="用户名">{plainText(profile?.username)}</Descriptions.Item>
          <Descriptions.Item label="邮箱">{plainText(profile?.email)}</Descriptions.Item>
          <Descriptions.Item label="状态"><Tag color={profile?.status === 'active' ? 'green' : 'default'}>{plainText(profile?.status)}</Tag></Descriptions.Item>
          <Descriptions.Item label="角色"><Space wrap>{profile?.roles.map((role) => <Tag key={role.id}>{plainText(role.name || role.code)}</Tag>)}</Space></Descriptions.Item>
          <Descriptions.Item label="最近登录">{formatTime(profile?.lastLoginAt)}</Descriptions.Item>
        </Descriptions>
      </Card>
      <Card title="修改密码" style={{ marginTop: 16 }}>
        <Alert type="info" showIcon message={PASSWORD_RULE_MESSAGE} />
        <Form form={form} layout="vertical" style={{ maxWidth: 480, marginTop: 16 }} onFinish={() => void submitPassword()}>
          <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码。' }]}><Input.Password autoComplete="current-password" maxLength={256} /></Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码。' }]}><Input.Password autoComplete="new-password" maxLength={256} /></Form.Item>
          <Form.Item name="confirmPassword" label="确认新密码" dependencies={['newPassword']} rules={[{ required: true, message: '请再次输入新密码。' }, ({ getFieldValue }) => ({ validator: (_, value) => value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入的新密码不一致。')) })]}><Input.Password autoComplete="new-password" maxLength={256} /></Form.Item>
          <Button type="primary" htmlType="submit" danger loading={changing}>修改密码并退出全部设备</Button>
        </Form>
      </Card>
      <Card title="有效登录会话" style={{ marginTop: 16 }}>
        <Table rowKey="id" loading={loading} columns={columns} dataSource={sessions} pagination={false} scroll={{ x: 900 }} />
      </Card>
    </section>
  );
}

function plainText(value?: string | null) { return value || '—'; }
function formatTime(value?: string | null) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function isFormValidationError(error: unknown): error is { errorFields: unknown[] } {
  return typeof error === 'object' && error !== null && Array.isArray((error as { errorFields?: unknown }).errorFields);
}
