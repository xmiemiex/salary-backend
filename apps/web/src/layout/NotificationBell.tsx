import { Badge, Button, Dropdown, Empty, List, Space, Tag, Typography, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiClient } from '../lib/api-client';
import { hasPermission } from '../lib/permissions';
import type { Actor } from '../types/session';
import { containsSensitiveAlertField, type NotificationItem, severityColor } from '../pages/alerts-utils';

type Props = {
  actor: Actor;
  onNavigate: (path: string) => void;
};

export function NotificationBell({ actor, onNavigate }: Props) {
  const canRead = hasPermission(actor, 'notifications.read');
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    try {
      const [countResult, listResult] = await Promise.all([
        apiClient.request<{ count: number }>('/notifications/unread-count'),
        apiClient.request<{ items: NotificationItem[] }>('/notifications?pageSize=6'),
      ]);
      if (containsSensitiveAlertField(listResult)) {
        messageApi.error('通知内容包含敏感字段，已阻止渲染。');
        setItems([]);
        setCount(0);
        return;
      }
      setCount(countResult.count);
      setItems(listResult.items);
    } catch (error) {
      messageApi.error(error instanceof ApiError ? error.message : '通知加载失败。');
    } finally {
      setLoading(false);
    }
  }, [canRead, messageApi]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canRead) return null;

  const markRead = async (id: string) => {
    await apiClient.request(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
    await load();
  };

  const readAll = async () => {
    await apiClient.request('/notifications/read-all', { method: 'POST' });
    await load();
  };

  return (
    <>
      {contextHolder}
      <Dropdown
        trigger={['click']}
        popupRender={() => (
          <div className="notification-popover" data-testid="notification-popover">
            <div className="notification-popover-header">
              <Typography.Text strong>站内通知</Typography.Text>
              <Button size="small" type="link" disabled={!count} onClick={readAll}>
                全部已读
              </Button>
            </div>
            {items.length ? (
              <List
                dataSource={items}
                renderItem={(item) => (
                  <List.Item
                    actions={[
                      item.alertId ? <Button size="small" type="link" onClick={() => onNavigate('/alerts')}>查看告警</Button> : null,
                      item.readAt ? null : <Button size="small" onClick={() => markRead(item.id)}>已读</Button>,
                    ].filter(Boolean)}
                  >
                    <List.Item.Meta
                      title={<Space><Tag color={severityColor(item.severity)}>{item.severity}</Tag><span>{item.title}</span></Space>}
                      description={<span>{item.safeMessage}</span>}
                    />
                  </List.Item>
                )}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '加载中' : '暂无通知'} />
            )}
          </div>
        )}
      >
        <Badge count={count} size="small">
          <Button aria-label="站内通知" onClick={() => void load()}>通知</Button>
        </Badge>
      </Dropdown>
    </>
  );
}
