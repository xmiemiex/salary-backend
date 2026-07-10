import { Alert, Button, Checkbox, Descriptions, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import type { Actor } from '../types/session';
import { buildRolesQuery, canManageRoles, containsSensitiveRoleField, nextModuleSelection, permissionGroups, type RoleFilters } from './role-utils';

type Permission = { id: string; code: string; name: string; description: string | null; module: string };
type Role = { id: string; code: string; name: string; description: string | null; status: 'active' | 'disabled'; system: boolean; permissionCount: number; adminCount: number; permissions: Permission[]; createdAt: string; updatedAt: string };
type Payload = { items: Role[]; total: number; page: number; pageSize: number };
type Editor = { name: string; description?: string; status: 'active' | 'disabled'; permissionIds: string[] };
const initial: RoleFilters = { page: 1, pageSize: 20 };

export function RolesPage({ actor }: { actor: Actor }) {
  const canManage = canManageRoles(actor);
  const [rows, setRows] = useState<Role[]>([]); const [permissions, setPermissions] = useState<Permission[]>([]); const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<RoleFilters>(initial); const [loading, setLoading] = useState(false); const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null); const [open, setOpen] = useState(false); const [details, setDetails] = useState<Role | null>(null);
  const [form] = Form.useForm<Editor>(); const [filterForm] = Form.useForm(); const [messageApi, holder] = message.useMessage(); const [modalApi, modalHolder] = Modal.useModal();
  const selectedPermissionIds = Form.useWatch('permissionIds', form) ?? [];
  const showError = useCallback((e: unknown) => messageApi.error(e instanceof ApiError || e instanceof Error ? e.message : '角色操作失败。'), [messageApi]);
  const load = useCallback(async (next: RoleFilters) => { setLoading(true); try { const [payload, catalog] = await Promise.all([apiClient.request<Payload>(`/roles?${buildRolesQuery(next)}`), apiClient.request<Permission[]>('/roles/permissions')]); if (containsSensitiveRoleField(payload) || containsSensitiveRoleField(catalog)) throw new Error('接口返回了敏感字段，页面已拒绝渲染。'); setRows(payload.items); setTotal(payload.total); setPermissions(catalog); setFilters({ ...next, page: payload.page, pageSize: payload.pageSize }); } catch (e) { showError(e); } finally { setLoading(false); } }, [showError]);
  useEffect(() => { void load(initial); }, [load]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      form.resetFields();
      form.setFieldsValue(editing
        ? { name: editing.name, description: editing.description ?? '', status: editing.status, permissionIds: editing.permissions.map((permission) => permission.id) }
        : { status: 'active', permissionIds: [] });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [editing, form, open]);
  const groups = useMemo(() => permissionGroups(permissions), [permissions]);
  const openCreate = () => { setEditing(null); setOpen(true); };
  const openEdit = (role: Role) => { setEditing(role); setOpen(true); };
  const submit = async () => { await form.validateFields(['name', 'description', 'status']); const values = form.getFieldsValue(true); if (!Array.isArray(values.permissionIds) || values.permissionIds.length === 0) { messageApi.error('至少选择一个权限。'); return; } setSaving(true); try { const body = { name: values.name, description: values.description ?? '', status: values.status, permissionIds: values.permissionIds }; await apiClient.request(editing ? `/roles/${editing.id}` : '/roles', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) }); messageApi.success(editing ? '角色已更新；权限变更会使关联管理员重新登录。' : '角色已创建。'); setOpen(false); await load(filters); } catch (e) { showError(e); } finally { setSaving(false); } };
  const changeEnabled = (role: Role, enabled: boolean) => modalApi.confirm({ title: `确认${enabled ? '启用' : '停用'}角色“${role.name}”？`, content: enabled ? '启用不会恢复已撤销的旧会话。' : '已分配管理员的角色不能停用；系统不会静默解绑管理员。', okText: `确认${enabled ? '启用' : '停用'}`, okButtonProps: { danger: !enabled }, cancelText: '取消', async onOk() { try { await apiClient.request(`/roles/${role.id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }); messageApi.success(`角色已${enabled ? '启用' : '停用'}。`); await load(filters); } catch (e) { showError(e); } } });
  const columns = useMemo<ColumnsType<Role>>(() => [
    { title: '角色名称', dataIndex: 'name', key: 'name', render: (name, r) => <Space>{name}{r.system ? <Tag color="red">系统角色</Tag> : null}</Space> },
    { title: '描述', dataIndex: 'description', key: 'description', ellipsis: true }, { title: '状态', dataIndex: 'status', key: 'status', render: (s) => <Tag color={s === 'active' ? 'green' : 'default'}>{s === 'active' ? '启用' : '停用'}</Tag> },
    { title: '权限数', dataIndex: 'permissionCount', key: 'permissionCount', width: 90 }, { title: '管理员数', dataIndex: 'adminCount', key: 'adminCount', width: 100 },
    { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', render: time }, { title: '更新时间', dataIndex: 'updatedAt', key: 'updatedAt', render: time },
    { title: '操作', key: 'actions', fixed: 'right', render: (_, r) => <Space><Button size="small" onClick={() => setDetails(r)}>详情</Button>{canManage ? <><Button size="small" onClick={() => openEdit(r)}>编辑</Button>{r.status === 'active' ? <Tooltip title={r.system ? 'super_admin 系统角色不能停用' : undefined}><Button danger size="small" disabled={r.system} onClick={() => changeEnabled(r, false)}>停用</Button></Tooltip> : <Button size="small" onClick={() => changeEnabled(r, true)}>启用</Button>}</> : null}</Space> },
  ], [canManage, filters]);
  const pagination: TablePaginationConfig = { current: filters.page, pageSize: filters.pageSize, total, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] };
  return <section className="page-section data-page">{holder}{modalHolder}<div className="data-page-header"><Typography.Title level={3}>角色与权限</Typography.Title><Space><Button loading={loading} onClick={() => load(filters)}>刷新</Button>{canManage ? <Button type="primary" onClick={openCreate}>创建角色</Button> : null}</Space></div>
    {!canManage ? <Alert type="info" showIcon message="当前账号只有角色查看权限。" /> : null}
    <Form form={filterForm} layout="inline" className="data-filter" onFinish={(v) => void load({ ...filters, ...v, page: 1 })}><Form.Item name="search" label="名称"><Input allowClear maxLength={128} /></Form.Item><Form.Item name="status" label="状态"><Select allowClear style={{ width: 120 }} options={[{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用' }]} /></Form.Item><Form.Item><Space><Button type="primary" htmlType="submit">查询</Button><Button onClick={() => { filterForm.resetFields(); void load(initial); }}>重置</Button></Space></Form.Item></Form>
    <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} pagination={pagination} scroll={{ x: 1200 }} onChange={(p) => void load({ ...filters, page: p.current ?? 1, pageSize: p.pageSize ?? 20 })} />
    <Modal title={editing ? `编辑角色：${editing.name}` : '创建角色'} open={open} confirmLoading={saving} onOk={() => void submit()} onCancel={() => setOpen(false)} destroyOnHidden width={720}>
      {editing?.system ? <Alert type="warning" showIcon message="super_admin 的稳定标识、启用状态和核心管理权限受后端强制保护。" style={{ marginBottom: 16 }} /> : null}
      <Form form={form} layout="vertical" preserve={false}><Form.Item name="name" label="角色名称" rules={[{ required: true }, { min: 2, max: 64 }, { pattern: /^[\p{L}\p{N} _-]+$/u, message: '仅允许字母、数字、空格、下划线和连字符。' }]}><Input disabled={editing?.system} /></Form.Item><Form.Item name="description" label="描述" rules={[{ max: 1000 }]}><Input.TextArea rows={3} /></Form.Item><Form.Item name="status" label="状态" rules={[{ required: true }]}><Select options={[{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用', disabled: editing?.system }]} /></Form.Item><Form.Item name="permissionIds" hidden><Select mode="multiple" options={permissions.map((p) => ({ value: p.id, label: p.code }))} /></Form.Item><Form.Item label="权限" required>{groups.map(([module, items]) => <div key={module} style={{ marginBottom: 12 }}><Space><Typography.Text strong>{module}</Typography.Text><Checkbox checked={items.every((p) => selectedPermissionIds.includes(p.id))} indeterminate={items.some((p) => selectedPermissionIds.includes(p.id)) && !items.every((p) => selectedPermissionIds.includes(p.id))} onChange={(e) => form.setFieldValue('permissionIds', nextModuleSelection(selectedPermissionIds, items.map((p) => p.id), e.target.checked))}>模块全选/取消</Checkbox></Space><div>{items.map((p) => <Checkbox key={p.id} checked={selectedPermissionIds.includes(p.id)} disabled={Boolean(editing?.system && ['role.read', 'role.manage', 'admin_users.read', 'admin_users.manage'].includes(p.code))} onChange={(e) => form.setFieldValue('permissionIds', nextModuleSelection(selectedPermissionIds, [p.id], e.target.checked))}>{p.name} ({p.code})</Checkbox>)}</div></div>)}</Form.Item></Form>
    </Modal>
    <Drawer title="角色详情" open={Boolean(details)} onClose={() => setDetails(null)} width={560}>{details ? <><Descriptions column={1} bordered size="small" items={[{ key: 'name', label: '名称', children: details.name }, { key: 'code', label: '稳定标识', children: details.code }, { key: 'status', label: '状态', children: details.status }, { key: 'admins', label: '管理员数量', children: details.adminCount }, { key: 'description', label: '描述', children: details.description || '-' }]} /><Typography.Title level={5}>权限</Typography.Title><Space wrap>{details.permissions.map((p) => <Tag key={p.id}>{p.code}</Tag>)}</Space></> : null}</Drawer>
  </section>;
}
function time(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
