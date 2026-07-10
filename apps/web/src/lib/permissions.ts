import type { Actor } from '../types/session';

export function hasPermission(actor: Actor | null | undefined, permission: string): boolean {
  return Boolean(actor?.permissions.includes(permission));
}

export function hasAnyPermission(actor: Actor | null | undefined, permissions: string[]): boolean {
  if (permissions.length === 0) return true;
  return permissions.some((permission) => hasPermission(actor, permission));
}

export function hasAllPermissions(actor: Actor | null | undefined, permissions: string[]): boolean {
  return permissions.every((permission) => hasPermission(actor, permission));
}
