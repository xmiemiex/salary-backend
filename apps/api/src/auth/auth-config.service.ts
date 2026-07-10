import { Injectable } from '@nestjs/common';

export const DEFAULT_SESSION_TTL_HOURS = 12;
export const DEFAULT_SESSION_TTL_SECONDS = DEFAULT_SESSION_TTL_HOURS * 60 * 60;

export function parseSessionTtlSeconds(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_SESSION_TTL_SECONDS;
  if (!/^\d+$/.test(value)) throw new Error('ADMIN_SESSION_TTL_SECONDS must be an integer between 60 and 604800.');
  const parsed = Number(value);
  if (parsed < 60 || parsed > 604800) throw new Error('ADMIN_SESSION_TTL_SECONDS must be an integer between 60 and 604800.');
  return parsed;
}

export function parseSessionTtlHours(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_SESSION_TTL_HOURS;
  if (!/^\d+$/.test(value)) throw new Error('AUTH_SESSION_TTL_HOURS must be an integer between 1 and 168.');
  const parsed = Number(value);
  if (parsed < 1 || parsed > 168) throw new Error('AUTH_SESSION_TTL_HOURS must be an integer between 1 and 168.');
  return parsed;
}

export function parseWebOrigin(value: string | undefined): string {
  const configured = value ?? 'http://localhost:5173';
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('WEB_ORIGIN must be a valid absolute http(s) origin.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== configured || url.username || url.password) {
    throw new Error('WEB_ORIGIN must be a valid absolute http(s) origin without a path, query, credentials, or trailing slash.');
  }
  return url.origin;
}

@Injectable()
export class AuthConfigService {
  readonly sessionTtlHours = process.env.ADMIN_SESSION_TTL_SECONDS === undefined
    ? parseSessionTtlHours(process.env.AUTH_SESSION_TTL_HOURS)
    : parseSessionTtlSeconds(process.env.ADMIN_SESSION_TTL_SECONDS) / 3600;
}
