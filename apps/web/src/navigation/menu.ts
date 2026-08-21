export type AdminMenuItem = {
  key: string;
  title: string;
  path: string;
  permissions?: string[];
  roles?: string[];
};

export function isAdminMenuItemVisible(
  item: AdminMenuItem,
  actor: { roleCode: string; permissions: string[] },
) {
  const roleAllowed = !item.roles || item.roles.includes(actor.roleCode);
  const permissionAllowed = !item.permissions || item.permissions.some((permission) => actor.permissions.includes(permission));
  return roleAllowed && permissionAllowed;
}

export const ADMIN_MENU: AdminMenuItem[] = [
  { key: 'dashboard', title: '运营总览', path: '/dashboard' },
  { key: 'security', title: '个人安全', path: '/security' },
  { key: 'admin-users', title: '管理员账号', path: '/admin-users', permissions: ['admin_users.read'] },
  { key: 'roles', title: '角色与权限', path: '/roles', permissions: ['role.read'] },
  { key: 'employees', title: '员工管理', path: '/employees', permissions: ['employee.manage'] },
  { key: 'affiliate-accounts', title: '联盟账号', path: '/affiliate-accounts', permissions: ['api_config.manage'] },
  { key: 'api-credentials', title: 'API 凭证配置', path: '/api-credentials', permissions: ['api_config.manage'] },
  { key: 'sub-id-mappings', title: 'SUB ID 映射', path: '/sub-id-mappings', permissions: ['sub_id_mapping.manage'] },
  { key: 'card-bindings', title: '虚拟卡绑定', path: '/card-bindings', permissions: ['card_binding.manage', 'photonpay_unmatched.read', 'photonpay_email_alias.manage', 'provider_card_exclusion.manage'] },
  {
    key: 'monthly-exchange-rates',
    title: '汇率设置',
    path: '/monthly-exchange-rates',
    permissions: ['monthly_exchange_rate.manage'],
  },
  {
    key: 'card-provider-fee-rates',
    title: '虚拟卡手续费',
    path: '/card-provider-fee-rates',
    permissions: ['card_provider_fee_rate.manage'],
  },
  { key: 'manual-income-records', title: '手动收入', path: '/manual-income-records', permissions: ['income.import'] },
  {
    key: 'cake-income-adjustments',
    title: 'CAKE SUB 收入调整',
    path: '/cake-income-adjustments',
    permissions: ['income.import'],
    roles: ['super_admin'],
  },
  {
    key: 'data-sync',
    title: '数据同步',
    path: '/data-sync',
    permissions: ['income.import', 'manual_card_spend.manage'],
  },
  {
    key: 'sync-reconciliation',
    title: '同步数据核对',
    path: '/sync-reconciliation',
    permissions: ['salary.view_all'],
  },
  {
    key: 'sync-unmatched-events',
    title: '未匹配事件',
    path: '/sync-unmatched-events',
    permissions: ['salary.view_all', 'settlement.generate'],
  },
  {
    key: 'manual-card-spend',
    title: '手动卡花费',
    path: '/manual-card-spend',
    permissions: ['manual_card_spend.manage'],
  },
  {
    key: 'historical-negative-profits',
    title: '历史负毛利',
    path: '/historical-negative-profits',
    permissions: ['historical_negative_profit.manage'],
  },
  {
    key: 'performance-groups',
    title: '业绩分组',
    path: '/performance-groups',
    permissions: ['performance_group.manage'],
  },
  {
    key: 'salary-item-configs',
    title: '工资手动项配置',
    path: '/salary-item-configs',
    permissions: ['salary_item_config.manage'],
  },
  {
    key: 'salary-manual-items',
    title: '月度工资手动项',
    path: '/salary-manual-items',
    permissions: ['salary_manual_item.manage'],
  },
  {
    key: 'salary-settlements',
    title: '工资结算',
    path: '/salary-settlements',
    permissions: ['salary.view_all', 'settlement.generate', 'settlement.lock', 'salary.export'],
  },
  { key: 'audit-logs', title: '审计中心', path: '/audit-logs', permissions: ['audit_log.view'] },
  { key: 'system-health', title: '系统健康 / 运维中心', path: '/system-health', permissions: ['system_health.read'] },
  { key: 'alerts', title: '告警中心', path: '/alerts', permissions: ['alerts.read'] },
  { key: 'backup-recovery', title: '数据保全 / 备份恢复', path: '/backup-recovery', permissions: ['backup_status.read', 'restore_drill.read'] },
  { key: 'release-gate', title: '发布门禁 / 上线检查', path: '/release-gate', permissions: ['release_gate.read'] },
];
