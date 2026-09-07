import { Alert, Button, Form, Input, InputNumber, Space, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { exactUsd } from './cake-adjustment-totals';

type Entry = { id: string; source: string; amount: string; status: string; updatedAt: string; reason: string | null };
export function ManualIncomeEditor({ month, rowKey, subId, locked, onSaved, onBusy }: {
  month: string; rowKey: string; subId: string; locked: boolean; onSaved: () => Promise<void>; onBusy: (busy: boolean) => void;
}) {
  const [data, setData] = useState<{ items: Entry[]; confirmedTotal: string }>({ items: [], confirmedTotal: '0' });
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const [entry, setEntry] = useState<Entry | null>(null), [amount, setAmount] = useState('0'), [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await apiClient.request(`/dashboard/monthly/manual-income?${new URLSearchParams({ settlementMonth: month, rowKey })}`)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : '读取收入条目失败'); }
    finally { setLoading(false); }
  }, [month, rowKey]);
  useEffect(() => { void load(); }, [load]);
  const create = () => { setEntry(null); setAmount('0'); setReason(''); setRequestId(crypto.randomUUID()); setError(''); };
  const save = async () => {
    setSaving(true); onBusy(true); setError('');
    try {
      await apiClient.request('/dashboard/monthly/manual-income', { method: 'POST', body: JSON.stringify({ settlementMonth: month, rowKey, amount, ...(entry ? { id: entry.id, expectedUpdatedAt: entry.updatedAt } : { requestId, reason }) }) });
      create(); await load(); await onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请刷新列表核实后重试'); }
    finally { setSaving(false); onBusy(false); }
  };
  const statuses: Record<string, string> = { confirmed: '已确认', draft: '草稿', disabled: '已停用' };
  return <Space direction="vertical" style={{ width: '100%' }} size={16}>
    <Typography.Text>{month} · {subId} · 已计入手动收入合计 ${exactUsd(data.confirmedTotal)}</Typography.Text>
    <Typography.Text type="secondary">仅显示该员工本月无联盟归属的手动收入。编辑只修改选中条目的金额，保留来源、备注和状态；草稿及停用条目不计入合计。</Typography.Text>
    {error && <Alert type="error" showIcon message={error} />}
    <Space><Button onClick={create} disabled={saving || locked}>新增收入</Button><Button onClick={() => void load()} disabled={saving} loading={loading}>刷新收入列表</Button></Space>
    <Table<Entry> size="small" rowKey="id" dataSource={data.items} loading={loading} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 650 }} columns={[
      { title: '来源', dataIndex: 'source', width: 140 },
      { title: '收入 USD', dataIndex: 'amount', width: 130, align: 'right', render: value => `$${exactUsd(value)}` },
      { title: '状态', dataIndex: 'status', width: 100, render: value => <Tag>{statuses[value] ?? value}</Tag> },
      { title: '备注', dataIndex: 'reason', width: 180, render: value => value || '—' },
      { title: '操作', fixed: 'right', width: 80, render: (_, item) => <Button size="small" disabled={saving || locked} onClick={() => { setEntry(item); setAmount(item.amount); setError(''); }}>编辑条目</Button> },
    ]} />
    <Form layout="vertical" style={{ width: '100%' }}>
      <Typography.Title level={5}>{entry ? '编辑选中收入' : '新增手动收入'}</Typography.Title>
      {entry && <Typography.Paragraph>来源 {entry.source} · {statuses[entry.status]} · {entry.reason || '无备注'}。保存后状态保持不变。</Typography.Paragraph>}
      <Form.Item label="此条收入金额 USD"><InputNumber<string> aria-label="此条收入金额 USD" stringMode min="0" max="999999999999" precision={6} value={amount} onChange={value => setAmount(value ?? '')} disabled={saving || locked} style={{ width: '100%' }} /></Form.Item>
      {!entry && <Form.Item label="收入备注"><Input.TextArea aria-label="收入备注" value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} disabled={saving || locked} /></Form.Item>}
      <Button type="primary" loading={saving} disabled={loading || locked || !amount} onClick={() => void save()}>{entry ? '保存此条金额' : '新增并计入收入'}</Button>
    </Form>
  </Space>;
}
