import { Button, Layout, Menu, Space, Tag, Typography } from 'antd';
import type { Actor } from '../types/session';
import { hasAnyPermission } from '../lib/permissions';
import { ADMIN_MENU, type AdminMenuItem } from '../navigation/menu';
import { ApiCredentialsPage } from '../pages/ApiCredentialsPage';
import { BaseDataPage, hasBaseDataPage } from '../pages/BaseDataPages';
import { DataSyncPage } from '../pages/DataSyncPage';
import { NoPermissionPage, PlaceholderPage } from '../pages/PlaceholderPage';
import { SalarySettlementPage } from '../pages/SalarySettlementPage';
import { SyncReconciliationPage } from '../pages/SyncReconciliationPage';
import { SyncUnmatchedEventsPage } from '../pages/SyncUnmatchedEventsPage';
import { AuditLogsPage } from '../pages/AuditLogsPage';
import { AdminUsersPage } from '../pages/AdminUsersPage';
import { RolesPage } from '../pages/RolesPage';
import { SecurityPage } from '../pages/SecurityPage';
import { DashboardPage } from '../pages/DashboardPage';
import { SystemHealthPage } from '../pages/SystemHealthPage';
import { AlertsPage } from '../pages/AlertsPage';
import { BackupRecoveryPage } from '../pages/BackupRecoveryPage';
import { ReleaseGatePage } from '../pages/ReleaseGatePage';
import { NotificationBell } from './NotificationBell';

type AdminLayoutProps = {
  actor: Actor;
  currentPath: string;
  onNavigate: (path: string) => void;
  onLogout: () => void;
  onCurrentSessionInvalidated: () => void;
};

export function getVisibleMenu(actor: Actor): AdminMenuItem[] {
  return ADMIN_MENU.filter((item) => !item.permissions || hasAnyPermission(actor, item.permissions));
}

export function AdminLayout({ actor, currentPath, onNavigate, onLogout, onCurrentSessionInvalidated }: AdminLayoutProps) {
  const visibleMenu = getVisibleMenu(actor);
  const currentItem = ADMIN_MENU.find((item) => item.path === currentPath) ?? visibleMenu[0] ?? ADMIN_MENU[0];
  const canAccessCurrent = visibleMenu.some((item) => item.path === currentItem.path);

  return (
    <Layout className="admin-shell">
      <Layout.Sider width={232} className="admin-sider">
        <div className="brand-block">
          <Typography.Text strong>工资结算后台</Typography.Text>
          <Typography.Text type="secondary" className="brand-subtitle">
            Admin Console
          </Typography.Text>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[currentItem.key]}
          items={visibleMenu.map((item) => ({ key: item.key, label: item.title }))}
          onClick={({ key }) => {
            const next = visibleMenu.find((item) => item.key === key);
            if (next) onNavigate(next.path);
          }}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header className="admin-header">
          <Space size={8} wrap>
            <Tag color="blue">{actor.roleCode}</Tag>
            <Typography.Text>用户：{actor.userId}</Typography.Text>
            {actor.employeeId ? <Typography.Text type="secondary">员工：{actor.employeeId}</Typography.Text> : null}
          </Space>
          <Space>
            <NotificationBell actor={actor} onNavigate={onNavigate} />
            <Button onClick={onLogout}>退出登录</Button>
          </Space>
        </Layout.Header>
        <Layout.Content className="admin-content">
          {canAccessCurrent ? (
            currentItem.path === '/dashboard' ? (
              <DashboardPage actor={actor} onNavigate={onNavigate} />
            ) : currentItem.path === '/security' ? (
              <SecurityPage onCurrentSessionInvalidated={onCurrentSessionInvalidated} />
            ) : currentItem.path === '/admin-users' ? (
              <AdminUsersPage actor={actor} onCurrentSessionInvalidated={onCurrentSessionInvalidated} />
            ) : currentItem.path === '/roles' ? (
              <RolesPage actor={actor} />
            ) : currentItem.path === '/salary-settlements' ? (
              <SalarySettlementPage actor={actor} />
            ) : currentItem.path === '/audit-logs' ? (
              <AuditLogsPage actor={actor} />
            ) : currentItem.path === '/system-health' ? (
              <SystemHealthPage />
            ) : currentItem.path === '/alerts' ? (
              <AlertsPage actor={actor} onNavigate={onNavigate} />
            ) : currentItem.path === '/backup-recovery' ? (
              <BackupRecoveryPage actor={actor} />
            ) : currentItem.path === '/release-gate' ? (
              <ReleaseGatePage actor={actor} />
            ) : currentItem.path === '/api-credentials' ? (
              <ApiCredentialsPage />
            ) : currentItem.path === '/data-sync' ? (
              <DataSyncPage />
            ) : currentItem.path === '/sync-reconciliation' ? (
              <SyncReconciliationPage />
            ) : currentItem.path === '/sync-unmatched-events' ? (
              <SyncUnmatchedEventsPage />
            ) : hasBaseDataPage(currentItem.path) ? (
              <BaseDataPage path={currentItem.path} />
            ) : (
              <PlaceholderPage item={currentItem} />
            )
          ) : (
            <NoPermissionPage />
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
