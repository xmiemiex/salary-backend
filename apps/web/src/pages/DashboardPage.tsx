import { Alert, Button, DatePicker, Drawer, Form, Input, InputNumber, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../lib/api-client';
import type { Actor } from '../types/session';
import { currentGmt8Month, formatDashboardMoney, formatDashboardTime } from './dashboard-utils';

type Amounts = { totalIncome: string; otherIncome: string; rawSpend: string; totalSpend: string | null; profit: string | null; margin: string | null; byAffiliate: Record<string, string>; spends: Record<string, string> };
type Row = Amounts & { key: string; subId: string; subIds: string[]; attributionPending: boolean; missingRates: string[]; otherManualCost: string };
type Data = { coverageScope: 'full_month' | 'month_to_date' | 'future'; localSample: boolean; month: string; locked: boolean; columns: { key: string; name: string }[]; rates: Record<string, string | null>; rows: Row[]; totals: Amounts; sources: { key: string; name: string; status: string; reason: string | null; lastSuccessAt: string | null; coveredThrough: string | null; updatedAt: string | null }[]; complete: boolean; refreshing: boolean; batchId: string | null; queriedAt: string; coveredThrough: string | null };
const names: Record<string, string> = { airwallex: 'Airwallex', photonpay: 'PhotonPay', adpos: 'Adpos' };
const statuses: Record<string, string> = { completed: '已同步', missing: '未同步', pending: '等待刷新', running: '刷新中', retry_wait: '稍后自动重试', failed: '刷新失败', partial: '部分成功', cancelled: '已取消' };
const money = (value: string | null | undefined) => value == null ? '待填写手续费' : formatDashboardMoney(value);
const percentToRate = (value: string) => { const [whole, fraction = ''] = value.split('.'); return `${whole.padStart(3, '0').slice(0, -2)}.${whole.padStart(2, '0').slice(-2)}${fraction}`; };

export function DashboardPage({ actor, onNavigate }: { actor: Actor; onNavigate: (path: string) => void }) {
  const [month, setMonth] = useState(currentGmt8Month());
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const [panel, setPanel] = useState<'fees' | 'detail' | 'adpos' | 'sub' | null>(null);
  const [row, setRow] = useState<Row | null>(null), [amount, setAmount] = useState('0'), [unifiedSub, setUnifiedSub] = useState('');
  const [feeInputs, setFeeInputs] = useState<Record<string, string | null>>({});
  const [detailPage, setDetailPage] = useState(1), [detailCategory, setDetailCategory] = useState('income');
  const [detailData, setDetailData] = useState<{ total: number; items: { key: string; source: string; amount: string; date: string | null }[] }>({ total: 0, items: [] });
  const [detailLoading, setDetailLoading] = useState(false);
  const sequence = useRef(0), currentMonth = useRef(month);
  const canRefresh = actor.permissions.includes('income.import') && actor.permissions.includes('manual_card_spend.manage');
  const load = useCallback(async () => {
    const request = ++sequence.current; setLoading(true);
    try { const next = await apiClient.request<Data>(`/dashboard/monthly?settlementMonth=${month}`); if (request === sequence.current && currentMonth.current === month) { setData(next); setError(''); } }
    catch (e) { if (request === sequence.current) setError(e instanceof Error ? e.message : '读取失败，已保留上次成功数据'); }
    finally { if (request === sequence.current) setLoading(false); }
  }, [month]);
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [load]);
  useEffect(() => {
    if (!data?.refreshing) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const next = await apiClient.request<Pick<Data, 'sources' | 'refreshing' | 'queriedAt' | 'coveredThrough' | 'batchId'>>(`/dashboard/monthly/status?settlementMonth=${month}`);
        if (cancelled || currentMonth.current !== month) return;
        if (!next.refreshing || JSON.stringify(next.sources) !== JSON.stringify(data.sources)) await load();
        else setData(previous => previous ? { ...previous, ...next } : previous);
      } catch (e) { if (!cancelled) { setError(e instanceof Error ? e.message : '读取刷新进度失败'); setData(previous => previous ? { ...previous } : previous); } }
    }, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [data, load, month]);
  useEffect(() => {
    if (panel !== 'detail' || !row) return;
    let cancelled = false; setDetailLoading(true); setDetailData({ total: 0, items: [] });
    apiClient.request<typeof detailData>(`/dashboard/monthly/details?settlementMonth=${month}&rowKey=${row.key}&page=${detailPage}&category=${detailCategory}`)
      .then(next => { if (!cancelled) setDetailData(next); }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : '明细读取失败'); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [panel, row, month, detailPage, detailCategory]);
  const selectMonth = (_: unknown, text: string | string[]) => { if (typeof text !== 'string' || !text || text === currentMonth.current) return; currentMonth.current = text; sequence.current++; setMonth(text); setData(null); setPanel(null); setRow(null); setError(''); };
  const post = async (path: string, payload: object) => {
    const submittedMonth = month; setSaving(true); setError('');
    try { await apiClient.request(`/dashboard/monthly/${path}`, { method: 'POST', body: JSON.stringify({ settlementMonth: submittedMonth, ...payload }) }); if (currentMonth.current === submittedMonth) { setPanel(null); await load(); } }
    catch (e) { if (currentMonth.current === submittedMonth) setError(e instanceof Error ? e.message : '保存失败，请重试'); }
    finally { setSaving(false); }
  };
  const openFees = () => { setFeeInputs(Object.fromEntries(Object.entries(data?.rates ?? {}).map(([k, v]) => [k, v == null ? null : String(Number(v) * 100)]))); setPanel('fees'); };
  const detail = (r: Row, category = 'income') => { setRow(r); setDetailPage(1); setDetailCategory(category); setPanel('detail'); };
  const numberColumn = (title: string, get: (r: Row) => string | null, width = 145, sourceKey?: string): ColumnsType<Row>[number] => ({ title, align: 'right', width, render: (_, r) => <button className="finance-money" onClick={() => detail(r, sourceKey === 'airwallex' || sourceKey === 'photonpay' ? sourceKey : 'income')}>{sourceKey && get(r) === '0' && !data?.sources.find(s => s.key === sourceKey)?.lastSuccessAt ? '待同步' : money(get(r))}</button> });
  const columns: ColumnsType<Row> = [
    { title: '统一 SUB ID', dataIndex: 'subId', fixed: 'left', width: 150, render: (_, r) => <Button type="link" onClick={() => detail(r)}>{r.subId}</Button> },
    { ...numberColumn('总收入 · USD', r => r.totalIncome, 140), fixed: 'left' },
    { ...numberColumn('含费总花费 · USD', r => r.totalSpend, 150), fixed: 'left' },
    { ...numberColumn('毛利 · USD', r => r.profit, 140), fixed: 'left' },
    { title: 'ROI', fixed: 'left', align: 'right', width: 105, render: (_, r) => r.margin == null ? '—' : `${r.margin}%` },
    { title: '联盟收入明细 · USD', className: 'finance-income-head', children: [...(data?.columns ?? []).map(c => numberColumn(c.name, r => r.byAffiliate[c.key] ?? '0', 145, c.key)), numberColumn('其他手动收入', r => r.otherIncome)] },
    { title: '花费明细 · USD', className: 'finance-cost-head', children: [numberColumn('Airwallex 原始花费', r => r.spends.airwallex, 165, 'airwallex'), numberColumn('PhotonPay 原始花费', r => r.spends.photonpay, 175, 'photonpay'),
      { title: 'Adpos 原始花费', align: 'right', width: 160, render: (_, r) => <Space><button className="finance-money" onClick={() => detail(r, 'manual')}>{money(r.spends.adpos)}</button>{actor.permissions.includes('manual_card_spend.manage') && <Button size="small" type="text" disabled={data?.locked || r.attributionPending} onClick={() => { setRow(r); setAmount(r.spends.adpos); setPanel('adpos'); }}>编辑</Button>}</Space> },
      numberColumn('未含手续费总花费', r => r.rawSpend, 175)] },
  ];
  const totalValues = data ? [data.totals.totalIncome, data.totals.totalSpend, data.totals.profit, data.totals.margin, ...data.columns.map(c => data.totals.byAffiliate[c.key] ?? '0'), data.totals.otherIncome, data.totals.spends.airwallex, data.totals.spends.photonpay, data.totals.spends.adpos, data.totals.rawSpend] : [];
  if (!actor.permissions.includes('salary.view_all')) return <Alert type="info" message="当前账号没有月度收支查看权限。" />;
  return <section className="monthly-finance">
    <div className="finance-toolbar"><Typography.Title level={3}>月度收支</Typography.Title><Space wrap><DatePicker picker="month" allowClear={false} placeholder={month} onChange={selectMonth} disabled={saving} />{canRefresh && <Button type="primary" loading={loading || saving || data?.refreshing} disabled={data?.locked} onClick={() => void post('refresh', {})}>刷新数据</Button>}{actor.permissions.includes('card_provider_fee_rate.manage') && <Button onClick={openFees}>本月手续费</Button>}</Space></div>
    <div className="finance-status"><Space wrap>{data?.localSample && <Tag color="blue">本地模拟样例</Tag>}<Tag color={data?.complete ? 'green' : 'orange'}>{data?.refreshing ? '正在刷新数据' : data?.complete ? data.coverageScope === 'month_to_date' ? '已同步截至所示时间' : '整月已覆盖' : '数据尚不完整'}</Tag>{data?.locked && <Tag>已锁账</Tag>}<span>查询时间 {formatDashboardTime(data?.queriedAt ?? null)} · 共同覆盖至 {data?.coveredThrough ? formatDashboardTime(data.coveredThrough) : '尚未完整覆盖'} · GMT+8</span><Button type="link" size="small" onClick={() => onNavigate('/data-sync')}>同步详情</Button></Space></div>
    {error && <Alert showIcon type="error" message={error} description="已保留上次成功数据。连接恢复后可重试；刷新任务状态可在重新打开页面后恢复。" />}
    {data && <><div className="finance-source-line">{data.sources.map(s => <Space key={s.key} size={4}><span>{s.name}</span><Tag color={s.status === 'completed' ? 'green' : ['failed','partial'].includes(s.status) ? 'red' : 'default'}>{statuses[s.status] ?? s.status}</Tag>{s.reason && <span>{s.reason}</span>}{s.lastSuccessAt && <span>上次成功 {formatDashboardTime(s.lastSuccessAt)} · 覆盖至 {formatDashboardTime(s.coveredThrough)}</span>}{canRefresh && ['failed','partial'].includes(s.status) && <Button type="link" size="small" disabled={data.locked || data.refreshing || saving} onClick={() => void post('refresh', { source: s.key })}>重试</Button>}</Space>)}</div>
    {data.rows.some(r => r.attributionPending) && <Alert type="warning" message="部分归属尚未设置统一 SUB ID，点击对应行可设置。" />}{data.rows.some(r => r.otherManualCost !== '0') && <Alert type="info" message="总花费包含历史其他手动平台花费，点击金额查看来源。" />}
    <Table<Row> className="finance-table" size="middle" bordered pagination={false} loading={loading} rowKey="key" columns={columns} dataSource={data.rows} scroll={{ x: 'max-content' }} locale={{ emptyText: '本月暂无账目，点击刷新数据获取已配置来源。' }} summary={() => <Table.Summary fixed><Table.Summary.Row><Table.Summary.Cell index={0}><strong>合计{!data.complete ? '（不完整）' : ''}</strong></Table.Summary.Cell>{totalValues.map((value, i) => <Table.Summary.Cell key={i} index={i+1} align="right"><strong>{i === 3 ? value == null ? '—' : `${value}%` : money(value)}</strong></Table.Summary.Cell>)}</Table.Summary.Row></Table.Summary>} />
    <div className="finance-footnote">金额 USD · 仅含已确认收入与已结算消费 · ROI = 毛利 ÷ 含手续费总花费 × 100%</div></>}
    <Drawer title={panel === 'fees' ? `${month} · 本月手续费` : panel === 'adpos' ? `${row?.subId} · Adpos 原始花费` : panel === 'sub' ? '统一 SUB ID' : `${row?.subId ?? ''} · 来源明细`} open={panel !== null} onClose={() => !saving && setPanel(null)} width={520} destroyOnClose>
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
      {panel === 'fees' && <Form layout="vertical"><Typography.Paragraph type="secondary">仅保存到 {month}。0% 合法，未填表示待填写。</Typography.Paragraph>{Object.entries(names).map(([key, name]) => <Form.Item key={key} label={`${name} 费率`} required><InputNumber<string> stringMode min="0" max="100" precision={4} value={feeInputs[key]} addonAfter="%" placeholder="待填写" disabled={data?.locked || saving} onChange={v => setFeeInputs(prev => ({ ...prev, [key]: v }))} style={{ width: '100%' }} /></Form.Item>)}<Space><Button disabled={saving || data?.locked} onClick={async () => { const m = new Date(`${month}-01T00:00:00Z`); m.setUTCMonth(m.getUTCMonth()-1); const selected = month; try { const prior = await apiClient.request<Data>(`/dashboard/monthly?settlementMonth=${m.toISOString().slice(0,7)}`); if (currentMonth.current === selected) setFeeInputs(Object.fromEntries(Object.entries(prior.rates).map(([k,v]) => [k,v == null ? null : String(Number(v)*100)]))); } catch { setError('读取上月手续费失败。'); } }}>复制上月</Button><Button onClick={() => setPanel(null)}>取消</Button><Button type="primary" loading={saving} disabled={data?.locked || Object.keys(names).some(k => feeInputs[k] == null || feeInputs[k] === '')} onClick={() => void post('fees', { rates: Object.fromEntries(Object.keys(names).map(k => [k, percentToRate(feeInputs[k]!)])) })}>保存本月费率</Button></Space></Form>}
      {panel === 'adpos' && <Form layout="vertical"><Form.Item label={`${month} · 原始花费 USD`}><InputNumber<string> stringMode min="0" precision={6} value={amount} onChange={v => setAmount(v ?? '')} style={{ width: '100%' }} /></Form.Item><Space><Button onClick={() => setPanel(null)}>取消</Button><Button type="primary" loading={saving} disabled={!amount} onClick={() => void post('adpos', { subId: row?.subId, amount })}>保存花费</Button></Space></Form>}
      {panel === 'sub' && <Form layout="vertical"><Form.Item label="统一 SUB ID"><Input value={unifiedSub} onChange={e => setUnifiedSub(e.target.value)} maxLength={255} /></Form.Item><Typography.Paragraph>原始 SUB ID：{row?.subIds.join('、') || '暂无'}。这些联盟收入和卡成本将统一展示。</Typography.Paragraph><Space><Button onClick={() => setPanel('detail')}>取消</Button><Button type="primary" loading={saving} disabled={!unifiedSub.trim()} onClick={() => void post('sub-id', { rowKey: row?.key, subId: unifiedSub })}>保存统一标识</Button></Space></Form>}
      {panel === 'detail' && row && <><Typography.Paragraph>原始联盟 SUB ID：{row.subIds.join('、') || '待确认'}</Typography.Paragraph>{actor.permissions.includes('sub_id_mapping.manage') && <Button disabled={data?.locked || row.key === 'unassigned'} onClick={() => { setUnifiedSub(row.attributionPending ? '' : row.subId); setPanel('sub'); }}>设置统一 SUB ID</Button>}<Select aria-label="明细来源" value={detailCategory} onChange={value => { setDetailCategory(value); setDetailPage(1); }} options={[{ value: 'income', label: '全部收入' }, { value: 'airwallex', label: 'Airwallex 花费' }, { value: 'photonpay', label: 'PhotonPay 花费' }, { value: 'manual', label: 'Adpos / 其他手动花费' }]} style={{ width: '100%', margin: '16px 0' }} /><Table size="small" loading={detailLoading} pagination={{ current: detailPage, pageSize: 20, total: detailData.total, showSizeChanger: false, onChange: setDetailPage }} rowKey="key" dataSource={detailData.items} columns={[{ title: '来源', dataIndex: 'source' }, { title: '发生时间', dataIndex: 'date', render: value => formatDashboardTime(value) }, { title: 'USD', dataIndex: 'amount', align: 'right', render: money }]} /></>}
    </Drawer>
  </section>;
}
