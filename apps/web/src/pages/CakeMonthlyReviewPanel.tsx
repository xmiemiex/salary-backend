import { Button, Modal, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { apiClient } from '../lib/api-client';
import type { Actor } from '../types/session';
import { formatDashboardTime } from './dashboard-utils';

export type CakeMonthlyReview = {
  key: string; name: string;
  status: 'unreviewed' | 'confirmed_no_adjustment' | 'adjusted' | 'needs_review';
  reason: string | null; confirmedAt: string | null; confirmedBy: string | null;
  confirmedAdjustmentCount: number; staleAdjustmentCount: number; baseFingerprint: string;
};

export function CakeMonthlyReviewPanel({ reviews, month, locked, actor, onChanged, onNavigate }: {
  reviews: CakeMonthlyReview[]; month: string; locked: boolean; actor: Actor;
  onChanged: () => Promise<void>; onNavigate: (path: string) => void;
}) {
  const [modal, holder] = Modal.useModal();
  const [busy, setBusy] = useState(false);
  const canManage = actor.roleCode === 'super_admin' && actor.permissions.includes('income.import');
  const confirm = (review: CakeMonthlyReview, cancel = false) => modal.confirm({
    title: cancel ? `取消 ${review.name} 的人工核对？` : `${month} · ${review.name} · 确认已核对GMT+8时区佣金`,
    content: cancel ? '仅取消本账号、本月的独立核对记录，已有收入调整仍按其实际状态保留。'
      : '请确认已逐项核对本账号当月 GMT+8 口径佣金，无需新增加减调整。此操作只记录核对，不修改收入，也不代表 API 整月数据已经完整。',
    okText: cancel ? '取消核对' : '已核对，无需调整', cancelText: '返回',
    onOk: async () => {
      setBusy(true);
      try {
        await apiClient.request(`/cake-income-adjustments/monthly-review/${cancel ? 'cancel' : 'confirm'}`, {
          method: 'PATCH', body: JSON.stringify({ affiliateAccountId: review.key, settlementMonth: month, ...(!cancel ? { baseFingerprint: review.baseFingerprint } : {}) }),
        });
        await onChanged();
      } catch (error) {
        modal.error({ title: '核对未保存', content: error instanceof Error ? error.message : '请重试' });
        throw error;
      } finally { setBusy(false); }
    },
  });
  if (!reviews.length) return null;
  return <div className="finance-cake-review" style={{ padding: '10px 12px', background: '#fafafa', border: '1px solid #e8e8e8', borderRadius: 6, marginBottom: 12 }}>
    {holder}<Typography.Text strong>CAKE 人工核对 · {month}</Typography.Text>
    {reviews.map(review => <div key={review.key} data-cake-review={review.key} style={{ marginTop: 6 }}><Space wrap size={4}>
      <span>{review.name}</span>
      <Tag color={review.status === 'unreviewed' || review.status === 'needs_review' ? 'orange' : 'green'}>{review.status === 'unreviewed' ? '未核对GMT+8时区佣金' : review.status === 'needs_review' ? '待复核GMT+8时区佣金' : review.status === 'adjusted' ? `已有已确认调整（${review.confirmedAdjustmentCount} 条）` : '已核对GMT+8时区佣金，无需调整'}</Tag>
      {review.reason && <span>{review.reason}</span>}
      {review.confirmedAt && <span>人工核对于 {formatDashboardTime(review.confirmedAt)}</span>}
      {canManage && <><Button type="link" size="small" onClick={() => onNavigate(`/cake-income-adjustments?affiliateAccountId=${encodeURIComponent(review.key)}&settlementMonth=${month}`)}>查看 / 调整</Button>
        {(review.status === 'unreviewed' || review.status === 'needs_review') && review.staleAdjustmentCount === 0 && review.confirmedAdjustmentCount === 0 && <Button size="small" disabled={locked || busy} onClick={() => confirm(review)}>已核对，无需调整</Button>}
        {review.confirmedAt && <Button type="link" size="small" disabled={locked || busy} onClick={() => confirm(review, true)}>取消核对</Button>}</>}
    </Space></div>)}
    <Typography.Text type="secondary">人工核对独立于同步状态；已确认调整保留原 SUB 明细，收入按统一 SUB ID 汇总。</Typography.Text>
  </div>;
}
