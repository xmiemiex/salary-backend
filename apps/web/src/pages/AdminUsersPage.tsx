import { Alert, Button, Form, Input, Modal, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import { hasPermission } from '../lib/permissions';
import type { Actor } from '../types/session';
import { buildAdminUsersQuery, buildCreateAdminUserPayload, containsSensitiveAdminField, validatePasswordConfirmation, type AdminUserFilters } from './admin-user-utils';

type Role = { id: string; code: string; name: string; status: 'active' | 'disabled' };
type AdminUser = {
  id: string;
  username: string;
  email: string;
  status: 'active' | 'disabled';
  roles: Role[];
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string | null;
  lastSessionActivityAt?: string | null;
};
type ListPayload = { items: AdminUser[]; total: number; page: number; pageSize: number };
type EditorValues = { username?: string; email: string; password?: string; confirmPassword?: string; roleIds: string[]; status: 'active' | 'disabled' };
type PasswordValues = { password: string; confirmPassword: string };

const initialFilters: AdminUserFilters = { page: 1, pageSize: 20 };

export function AdminUsersPage({ actor, onCurrentSessionInvalidated }: { actor: Actor; onCurrentSessionInvalidated: () => void }) {
  const canManage = hasPermission(actor, 'admin_users.manage');
  const [rows, setRows] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<AdminUserFilters>(initialFilters);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [editorForm] = Form.useForm<EditorValues>();
  const [passwordForm] = Form.useForm<PasswordValues>();
  const [filterForm] = Form.useForm();
  const [messageApi, messageHolder] = message.useMessage();
  const [modalApi, modalHolder] = Modal.useModal();

  const showError = useCallback((error: unknown) => {
    messageApi.error(error instanceof ApiError || error instanceof Error ? error.message : '管理员操作失败。');
  }, [messageApi]);

  const load = useCallback(async (next: AdminUserFilters) => {
    setLoading(true);
    try {
      const [payload, availableRoles] = await Promise.all([
        apiClient.request<ListPayload>(`/admin-users?${buildAdminUsersQuery(next)}`),
        apiClient.request<Role[]>('/admin-users/roles'),
      ]);
      if (containsSensitiveAdminField(payload)) throw new Error('管理员接口返回了敏感字段，页面已拒绝渲染。');
      setRows(payload.items);
      setTotal(payload.total);
      setRoles(availableRoles);
      setFilters({ ...next, page: payload.page, pageSize: payload.pageSize });
    } catch (error) {
      showError(error);
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => { void load(initialFilters); }, [load]);

  useEffect(() => {
    if (!editorOpen) return;
    const timer = window.setTimeout(() => {
      editorForm.resetFields();
      editorForm.setFieldsValue(editing
        ? { email: editing.email, status: editing.status, roleIds: editing.roles.map((role) => role.id) }
        : { status: 'active', roleIds: [] });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [editing, editorForm, editorOpen]);

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const openEdit = (record: AdminUser) => {
    setEditing(record);
    setEditorOpen(true);
  };

  const submitEditor = async () => {
    try {
      const values = await editorForm.validateFields();
      if (!editing) {
        const passwordError = validatePasswordConfirmation(values.password ?? '', values.confirmPassword ?? '');
        if (passwordError) { messageApi.error(passwordError); return; }
      }
      setSaving(true);
      if (editing) {
        await apiClient.request(`/admin-users/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ email: values.email, status: values.status, roleIds: values.roleIds }),
        });
      } else {
        await apiClient.request('/admin-users', {
          method: 'POST',
          body: JSON.stringify(buildCreateAdminUserPayload(values)),
        });
      }
      messageApi.success(editing ? '管理员已更新。角色变更后需重新登录。' : '管理员已创建。');
      setEditorOpen(false);
      await load(filters);
    } catch (error) {
      if (isFormValidationError(error)) messageApi.error('请修正创建表单中的校验错误。');
      else showError(error);
    } finally {
      setSaving(false);
    }
  };

  const submitPasswordReset = async () => {
    if (!resetTarget) return;
    const values = await passwordForm.validateFields();
    const validation = validatePasswordConfirmation(values.password, values.confirmPassword);
    if (validation) { messageApi.error(validation); return; }
    modalApi.confirm({
      title: `确认重置 ${resetTarget.username} 的密码？`,
      content: '成功后该管理员的全部现有会话将立即失效。新密码不会在页面或接口中回显。',
      okText: '确认重置',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        setSaving(true);
        try {
          await apiClient.request(`/admin-users/${resetTarget.id}/reset-password`, {
            method: 'POST',
            body: JSON.stringify(values),
          });
          const isCurrent = resetTarget.id === actor.userId;
          setResetTarget(null);
          passwordForm.resetFields();
          if (isCurrent) onCurrentSessionInvalidated();
          else {
            messageApi.success('密码已重置，目标管理员的旧会话已撤销。');
            await load(filters);
          }
        } catch (error) { showError(error); }
        finally { setSaving(false); }
      },
    });
  };

  const changeEnabled = (record: AdminUser, enabled: boolean) => {
    modalApi.confirm({
      title: `${enabled ? '启用' : '停用'}管理员 ${record.username}？`,
      content: enabled ? '旧会话不会恢复，管理员需要重新登录。' : '停用后全部有效会话将立即撤销，且无法继续登录。',
      okText: `确认${enabled ? '启用' : '停用'}`,
      okButtonProps: { danger: !enabled },
      cancelText: '取消',
      async onOk() {
        try {
          await apiClient.request(`/admin-users/${record.id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
          messageApi.success(`管理员已${enabled ? '启用' : '停用'}。`);
          await load(filters);
        } catch (error) { showError(error); }
      },
    });
  };

  const columns = useMemo<ColumnsType<AdminUser>>(() => [
    { title: '用户名', dataIndex: 'username', key: 'username' },
    { title: '邮箱', dataIndex: 'email', key: 'email' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (status) => <Tag color={status === 'active' ? 'green' : 'default'}>{status === 'active' ? '启用' : '停用'}</Tag> },
    { title: '角色', key: 'roles', render: (_, record) => <Space wrap>{record.roles.map((role) => <Tag key={role.id} color={role.status === 'active' ? 'blue' : 'default'}>{role.name || role.code}</Tag>)}</Space> },
    { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', render: formatTime },
    { title: '更新时间', dataIndex: 'updatedAt', key: 'updatedAt', render: formatTime },
    { title: '最近登录', dataIndex: 'lastLoginAt', key: 'lastLoginAt', render: formatTime },
    { title: '最近会话活动', dataIndex: 'lastSessionActivityAt', key: 'lastSessionActivityAt', render: formatTime },
    {
      title: '操作', key: 'actions', fixed: 'right', render: (_, record) => canManage ? (
        <Space wrap>
          <Button size="small" onClick={() => openEdit(record)}>编辑</Button>
          <Button size="small" onClick={() => setResetTarget(record)}>重置密码</Button>
          {record.status === 'active' ? (
            <Tooltip title={record.id === actor.userId ? '不能停用当前登录账号' : undefined}>
              <Button danger size="small" disabled={record.id === actor.userId} onClick={() => changeEnabled(record, false)}>停用</Button>
            </Tooltip>
          ) : <Button size="small" onClick={() => changeEnabled(record, true)}>启用</Button>}
        </Space>
      ) : null,
    },
  ], [actor.userId, canManage, passwordForm]);

  const pagination: TablePaginationConfig = {
    current: filters.page,
    pageSize: filters.pageSize,
    total,
    showSizeChanger: true,
    pageSizeOptions: [10, 20, 50, 100],
  };

  return (
    <section className="page-section data-page">
      {messageHolder}{modalHolder}
      <div className="data-page-header">
        <Typography.Title level={3}>管理员账号</Typography.Title>
        <Space><Button loading={loading} onClick={() => load(filters)}>刷新</Button>{canManage ? <Button type="primary" onClick={openCreate}>创建管理员</Button> : null}</Space>
      </div>
      {!canManage ? <Alert type="info" showIcon message="当前账号仅有查看权限，不能修改管理员。" /> : null}
      <Form form={filterForm} layout="inline" className="data-filter" onFinish={(values) => void load({ ...filters, ...values, page: 1 })}>
        <Form.Item name="search" label="搜索"><Input allowClear placeholder="用户名或邮箱" maxLength={255} /></Form.Item>
        <Form.Item name="status" label="状态"><Select allowClear style={{ width: 120 }} options={[{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用' }]} /></Form.Item>
        <Form.Item name="roleId" label="角色"><Select allowClear showSearch optionFilterProp="label" style={{ width: 180 }} options={roles.map((role) => ({ value: role.id, label: role.name || role.code }))} /></Form.Item>
        <Form.Item><Space><Button type="primary" htmlType="submit">查询</Button><Button onClick={() => { filterForm.resetFields(); void load(initialFilters); }}>重置</Button></Space></Form.Item>
      </Form>
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 1300 }} onChange={(next) => void load({ ...filters, page: next.current ?? 1, pageSize: next.pageSize ?? 20 })} />

      <Modal title={editing ? `编辑管理员：${editing.username}` : '创建管理员'} open={editorOpen} confirmLoading={saving} okText="提交" cancelText="取消" onOk={() => void submitEditor()} onCancel={() => setEditorOpen(false)} destroyOnHidden>
        <Form form={editorForm} layout="vertical" preserve={false} initialValues={{ status: 'active', roleIds: [] }}>
          {!editing ? <Form.Item name="username" label="用户名" rules={[{ required: true }, { pattern: /^[A-Za-z0-9._-]{3,64}$/, message: '请输入 3-64 位字母、数字、点、下划线或连字符。' }]}><Input autoComplete="off" /></Form.Item> : null}
          <Form.Item name="email" label="邮箱" normalize={(value) => typeof value === 'string' ? value.trim().toLowerCase() : value} rules={[{ required: true }, { type: 'email' }]}><Input autoComplete="off" /></Form.Item>
          {!editing ? <><Form.Item name="password" label="初始密码" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item><Form.Item name="confirmPassword" label="确认密码" dependencies={['password']} rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, value) => value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('两次密码不一致。')) })]}><Input.Password autoComplete="new-password" /></Form.Item></> : null}
          <Form.Item name="roleIds" label="角色" rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个有效角色。' }]}><Select mode="multiple" options={roles.map((role) => ({ value: role.id, label: role.name || role.code, disabled: role.status !== 'active' || Boolean(editing?.id === actor.userId && role.code === 'super_admin') }))} /></Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}><Select options={[{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用', disabled: editing?.id === actor.userId }]} /></Form.Item>
        </Form>
      </Modal>

      <Modal title={`重置密码${resetTarget ? `：${resetTarget.username}` : ''}`} open={Boolean(resetTarget)} confirmLoading={saving} okText="下一步确认" cancelText="取消" onOk={() => void submitPasswordReset()} onCancel={() => setResetTarget(null)} afterOpenChange={(open) => { if (open) passwordForm.resetFields(); }} destroyOnHidden>
        <Alert type="warning" showIcon message="重置成功后，该管理员的全部现有会话将立即失效。" />
        <Form form={passwordForm} layout="vertical" preserve={false} style={{ marginTop: 16 }}>
          <Form.Item name="password" label="新密码" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item>
          <Form.Item name="confirmPassword" label="确认新密码" dependencies={['password']} rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, value) => value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('两次密码不一致。')) })]}><Input.Password autoComplete="new-password" /></Form.Item>
        </Form>
      </Modal>
    </section>
  );
}

function formatTime(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function isFormValidationError(error: unknown): error is { errorFields: unknown[] } {
  return typeof error === 'object' && error !== null && Array.isArray((error as { errorFields?: unknown }).errorFields);
}
