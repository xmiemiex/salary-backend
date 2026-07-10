import type { Actor } from '../types/session';

export type RoleFilters = { page: number; pageSize: number; search?: string; status?: 'active' | 'disabled' };
export function buildRolesQuery(filters: RoleFilters) { const q = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize) }); if (filters.search?.trim()) q.set('search', filters.search.trim()); if (filters.status) q.set('status', filters.status); return q.toString(); }
export function canReadRoles(actor: Actor) { return actor.permissions.includes('role.read'); }
export function canManageRoles(actor: Actor) { return actor.permissions.includes('role.manage'); }
export function permissionGroups<T extends { module: string }>(items: T[]) { return Object.entries(items.reduce<Record<string, T[]>>((groups, item) => { (groups[item.module] ??= []).push(item); return groups; }, {})).sort(([a], [b]) => a.localeCompare(b)); }
export function nextModuleSelection(current: string[], moduleIds: string[], checked: boolean) { const set = new Set(current); moduleIds.forEach((id) => checked ? set.add(id) : set.delete(id)); return [...set]; }
export function containsSensitiveRoleField(value: unknown): boolean { if (!value || typeof value !== 'object') return false; return Object.entries(value).some(([key, child]) => /^(password|passwordHash|token|tokenHash|encryptedPayload|databaseUrl)$/i.test(key) || containsSensitiveRoleField(child)); }
