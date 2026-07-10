import { Alert, Button, Descriptions, Drawer, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag, Typography, message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import { hasPermission } from '../lib/permissions';
import type { Actor } from '../types/session';
import {
  compactJson,
  containsSensitiveBackupField,
  formatTime,
  parseOptionalJson,
  statusColor,
  validateSafeInput,
  type BackupHealth,
  type BackupRecord,
  type BackupStatus,
  type BackupType,
  type RestoreDrillRecord,
  type RestoreDrillStatus,
} from './backup-recovery-utils';

type Props = { actor: Actor };
type Mode = 'backup' | 'drill';

const BACKUP_STATUS: BackupStatus[] = ['running', 'succeeded', 'failed', 'expired', 'unknown'];
const BACKUP_TYPE: BackupType[] = ['full', 'partial', 'schema_only', 'audit_only'];
const DRILL_STATUS: RestoreDrillStatus[] = ['running', 'succeeded', 'failed', 'cancelled'];

export function BackupRecoveryPage({ actor }: Props) {
  const canManageBackup = hasPermission(actor, 'backup_status.manage');
  const canManageDrill = hasPermission(actor, 'restore_drill.manage');
  const [health, setHealth] = useState<BackupHealth | null>(null);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [drills, setDrills] = useState<RestoreDrillRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BackupRecord | RestoreDrillRecord | null>(null);
  const [formMode, setFormMode] = useState<Mode | null>(null);
  const [editing, setEditing] = useState<BackupRecord | RestoreDrillRecord | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextHealth, backupPage, drillPage] = await Promise.all([
        apiClient.request<BackupHealth>('/backup-health'),
        apiClient.request<{ items: BackupRecord[] }>('/backup-records?page=1&pageSize=20'),
        apiClient.request<{ items: RestoreDrillRecord[] }>('/restore-drills?page=1&pageSize=20'),
      ]);
      const aggregate = { nextHealth, backupPage, drillPage };
      if (containsSensitiveBackupField(aggregate)) {
        setError('数据保全 API 返回包含敏感字段，页面已阻止渲染。');
        setHealth(null);
        setBackups([]);
        setDrills([]);
        return;
      }
      setHealth(nextHealth);
      setBackups(backupPage.items);
      setDrills(drillPage.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '数据保全加载失败。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openForm = (mode: Mode, record?: BackupRecord | RestoreDrillRecord) => {
    setFormMode(mode);
    setEditing(record ?? null);
  };

  const closeForm = () => {
    setFormMode(null);
    setEditing(null);
  };

  const submit = async (values: Record<string, unknown>) => {
    try {
      if (formMode === 'backup') {
        const body = toBackupPayload(values);
        const unsafe = validateSafeInput(body);
        if (unsafe) throw new Error(unsafe);
        if (editing) {
          await apiClient.request(`/backup-records/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
        } else {
          await apiClient.request('/backup-records', { method: 'POST', body: JSON.stringify(body) });
        }
      }
      if (formMode === 'drill') {
        const body = toDrillPayload(values);
        const unsafe = validateSafeInput(body);
        if (unsafe) throw new Error(unsafe);
        if (editing) {
          await apiClient.request(`/restore-drills/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
        } else {
          await apiClient.request('/restore-drills', { method: 'POST', body: JSON.stringify(body) });
        }
      }
      messageApi.success('记录已保存。');
      closeForm();
      await load();
    } catch (err) {
      messageApi.error(err instanceof Error ? err.message : '保存失败。');
    }
  };

  const latestBackups = useMemo(() => backups.slice(0, 5), [backups]);
  const latestDrills = useMemo(() => drills.slice(0, 5), [drills]);

  return (
    <div className="page-section backup-recovery-page" data-testid="backup-recovery-page">
      {contextHolder}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>数据保全 / 备份恢复</Typography.Title>
          <Typography.Text type="secondary">只记录运维或 CI 写入的备份元数据与恢复演练结果，不执行备份、恢复或文件下载。</Typography.Text>
        </div>
        <Space wrap>
          <Button onClick={load} loading={loading} data-testid="backup-recovery-refresh">刷新</Button>
          {canManageBackup ? <Button type="primary" onClick={() => openForm('backup')} data-testid="backup-create">新增备份记录</Button> : null}
          {canManageDrill ? <Button onClick={() => openForm('drill')} data-testid="drill-create">新增恢复演练</Button> : null}
        </Space>
      </div>

      {error ? <Alert className="data-page-notice" type="error" message={error} /> : null}

      <section className="health-panel" data-testid="backup-health-summary">
        <Typography.Title level={3}>备份健康摘要</Typography.Title>
        <Space size={12} wrap>
          <Tag color={statusColor(health?.status ?? 'warning')}>{health?.status ?? 'unknown'}</Tag>
          <span>成功备份距今：{health?.daysSinceLastSuccessBackup ?? '-' } 天</span>
          <span>成功演练距今：{health?.daysSinceLastSuccessDrill ?? '-' } 天</span>
        </Space>
        <div className="health-list">
          {(health?.checks ?? []).map((item) => (
            <div className="health-list-row" key={item.code}>
              <Tag color={statusColor(item.status)}>{item.status}</Tag>
              <span>{item.code}</span>
              <span>{item.message}</span>
            </div>
          ))}
        </div>
      </section>

      <Tabs
        items={[
          { key: 'recent-backups', label: '最近备份', children: <BackupTable items={latestBackups} loading={loading} canManage={canManageBackup} onDetail={setSelected} onEdit={(item) => openForm('backup', item)} /> },
          { key: 'recent-drills', label: '最近恢复演练', children: <DrillTable items={latestDrills} loading={loading} canManage={canManageDrill} onDetail={setSelected} onEdit={(item) => openForm('drill', item)} /> },
          { key: 'backup-list', label: '备份记录列表', children: <BackupTable items={backups} loading={loading} canManage={canManageBackup} onDetail={setSelected} onEdit={(item) => openForm('backup', item)} /> },
          { key: 'drill-list', label: '恢复演练列表', children: <DrillTable items={drills} loading={loading} canManage={canManageDrill} onDetail={setSelected} onEdit={(item) => openForm('drill', item)} /> },
        ]}
      />

      <Drawer width={640} title="记录详情" open={Boolean(selected)} onClose={() => setSelected(null)} data-testid="backup-detail-drawer">
        {selected ? <RecordDetail record={selected} /> : null}
      </Drawer>

      {formMode ? <RecordForm mode={formMode} record={editing} open={Boolean(formMode)} onCancel={closeForm} onSubmit={submit} /> : null}
    </div>
  );
}

function BackupTable({ items, loading, canManage, onDetail, onEdit }: { items: BackupRecord[]; loading: boolean; canManage: boolean; onDetail: (item: BackupRecord) => void; onEdit: (item: BackupRecord) => void }) {
  return (
    <Table
      rowKey="id"
      loading={loading}
      dataSource={items}
      pagination={false}
      columns={[
        { title: '状态', dataIndex: 'status', render: (value: BackupStatus) => <Tag color={statusColor(value)}>{value}</Tag> },
        { title: '类型', dataIndex: 'backupType' },
        { title: '备份 Key', dataIndex: 'backupKey' },
        { title: '存储别名', dataIndex: 'storageAlias' },
        { title: '加密', dataIndex: 'encrypted', render: (value: boolean) => (value ? '是' : '否') },
        { title: '开始时间', dataIndex: 'startedAt', render: formatTime },
        { title: '操作', render: (_, record) => <Space><Button size="small" onClick={() => onDetail(record)}>详情</Button>{canManage ? <Button size="small" onClick={() => onEdit(record)}>更新</Button> : null}</Space> },
      ]}
    />
  );
}

function DrillTable({ items, loading, canManage, onDetail, onEdit }: { items: RestoreDrillRecord[]; loading: boolean; canManage: boolean; onDetail: (item: RestoreDrillRecord) => void; onEdit: (item: RestoreDrillRecord) => void }) {
  return (
    <Table
      rowKey="id"
      loading={loading}
      dataSource={items}
      pagination={false}
      columns={[
        { title: '状态', dataIndex: 'status', render: (value: RestoreDrillStatus) => <Tag color={statusColor(value)}>{value}</Tag> },
        { title: '演练 Key', dataIndex: 'drillKey' },
        { title: '环境别名', dataIndex: 'environmentAlias' },
        { title: '备份 Key', dataIndex: 'backupKey', render: (value?: string) => value || '-' },
        { title: '开始时间', dataIndex: 'startedAt', render: formatTime },
        { title: '操作', render: (_, record) => <Space><Button size="small" onClick={() => onDetail(record)}>详情</Button>{canManage ? <Button size="small" onClick={() => onEdit(record)}>更新</Button> : null}</Space> },
      ]}
    />
  );
}

function RecordDetail({ record }: { record: BackupRecord | RestoreDrillRecord }) {
  return (
    <Space direction="vertical" size={16} className="page-stack">
      <Descriptions column={1} bordered size="small">
        {Object.entries(record).filter(([key]) => !['safeMetadata', 'scopeSummary', 'validationSummary'].includes(key)).map(([key, value]) => (
          <Descriptions.Item key={key} label={key}>{typeof value === 'boolean' ? (value ? '是' : '否') : String(value ?? '-')}</Descriptions.Item>
        ))}
      </Descriptions>
      <pre className="audit-json">{compactJson(isBackupRecord(record) ? record.scopeSummary : record.validationSummary)}</pre>
      <pre className="audit-json">{compactJson(record.safeMetadata)}</pre>
    </Space>
  );
}

function isBackupRecord(record: BackupRecord | RestoreDrillRecord): record is BackupRecord {
  return 'backupType' in record;
}

function RecordForm({ mode, record, open, onCancel, onSubmit }: { mode: Mode | null; record: BackupRecord | RestoreDrillRecord | null; open: boolean; onCancel: () => void; onSubmit: (values: Record<string, unknown>) => void }) {
  const [form] = Form.useForm();
  useEffect(() => {
    form.resetFields();
    if (!record) return;
    form.setFieldsValue({
      ...record,
      scopeSummary: compactJson((record as BackupRecord).scopeSummary),
      validationSummary: compactJson((record as RestoreDrillRecord).validationSummary),
      safeMetadata: compactJson(record.safeMetadata),
    });
  }, [form, record, open]);

  if (!open || !mode) return null;

  return (
    <Modal title={mode === 'backup' ? '备份记录' : '恢复演练'} open={open} onCancel={onCancel} onOk={() => form.submit()} destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        {mode === 'backup' ? (
          <>
            <Form.Item name="backupKey" label="backupKey" rules={[{ required: !record }]}><Input /></Form.Item>
            <Form.Item name="status" label="status" rules={[{ required: !record }]}><Select options={BACKUP_STATUS.map((value) => ({ value, label: value }))} /></Form.Item>
            <Form.Item name="backupType" label="backupType" rules={[{ required: !record }]}><Select options={BACKUP_TYPE.map((value) => ({ value, label: value }))} /></Form.Item>
            <Form.Item name="storageAlias" label="storageAlias" rules={[{ required: !record }]}><Input placeholder="primary-offsite" /></Form.Item>
            <Form.Item name="fileSizeBytes" label="fileSizeBytes"><InputNumber min={0} className="full-width-control" /></Form.Item>
            <Form.Item name="checksumSha256" label="checksumSha256"><Input /></Form.Item>
            <Form.Item name="encrypted" label="encrypted" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="encryptionAlias" label="encryptionAlias"><Input placeholder="kms-primary" /></Form.Item>
            <Form.Item name="scopeSummary" label="scopeSummary JSON"><Input.TextArea rows={3} /></Form.Item>
          </>
        ) : (
          <>
            <Form.Item name="drillKey" label="drillKey" rules={[{ required: !record }]}><Input /></Form.Item>
            <Form.Item name="status" label="status" rules={[{ required: !record }]}><Select options={DRILL_STATUS.map((value) => ({ value, label: value }))} /></Form.Item>
            <Form.Item name="environmentAlias" label="environmentAlias" rules={[{ required: !record }]}><Input placeholder="restore-ci" /></Form.Item>
            <Form.Item name="backupKey" label="backupKey"><Input /></Form.Item>
            <Form.Item name="validationSummary" label="validationSummary JSON"><Input.TextArea rows={3} /></Form.Item>
          </>
        )}
        <Form.Item name="startedAt" label="startedAt" rules={[{ required: !record }]}><Input placeholder="2026-07-09T00:00:00.000Z" /></Form.Item>
        <Form.Item name="completedAt" label="completedAt"><Input /></Form.Item>
        <Form.Item name="safeMetadata" label="safeMetadata JSON"><Input.TextArea rows={3} /></Form.Item>
        <Form.Item name="failureReason" label="failureReason"><Input.TextArea rows={2} /></Form.Item>
      </Form>
    </Modal>
  );
}

function toBackupPayload(values: Record<string, unknown>) {
  return {
    ...values,
    scopeSummary: parseOptionalJson(String(values.scopeSummary ?? '')),
    safeMetadata: parseOptionalJson(String(values.safeMetadata ?? '')),
  };
}

function toDrillPayload(values: Record<string, unknown>) {
  return {
    ...values,
    validationSummary: parseOptionalJson(String(values.validationSummary ?? '')),
    safeMetadata: parseOptionalJson(String(values.safeMetadata ?? '')),
  };
}
