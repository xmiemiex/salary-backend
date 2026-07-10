import type { Actor } from '../types/session';

export type AdminUserFilters = {
  search?: string;
  status?: string;
  roleId?: string;
  page: number;
  pageSize: number;
};

export type CreateAdminUserFormValues = {
  username?: string;
  email: string;
  password?: string;
  confirmPassword?: string;
  roleIds: string[];
  status: 'active' | 'disabled';
};

export function buildCreateAdminUserPayload(values: CreateAdminUserFormValues) {
  return {
    username: values.username,
    email: values.email,
    password: values.password,
    roleIds: [...values.roleIds],
    status: values.status,
  };
}

export function canReadAdminUsers(actor: Actor): boolean {
  return actor.permissions.includes('admin_users.read');
}

export function canManageAdminUsers(actor: Actor): boolean {
  return actor.permissions.includes('admin_users.manage');
}

export function buildAdminUsersQuery(filters: AdminUserFilters): string {
  const params = new URLSearchParams();
  params.set('page', String(filters.page));
  params.set('pageSize', String(filters.pageSize));
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  if (filters.status) params.set('status', filters.status);
  if (filters.roleId) params.set('roleId', filters.roleId);
  return params.toString();
}

export function validatePasswordConfirmation(password: string, confirmation: string): string | null {
  if (password.length < 12 || password.length > 256 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return '密码必须为 12-256 个字符，且至少包含一个字母和一个数字。';
  }
  if (password !== confirmation) return '两次输入的密码不一致。';
  return null;
}

export function containsSensitiveAdminField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveAdminField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    return ['password', 'passwordhash', 'token', 'tokenhash', 'secret', 'apikey'].includes(normalized)
      || containsSensitiveAdminField(child);
  });
}
