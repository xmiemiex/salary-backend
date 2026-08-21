import { createHash } from 'crypto';
import {
  CommonStatus,
  Provider,
  ProviderCardMatchSource,
  ProviderCardMatchStatus,
} from '@prisma/client';

export type MatchableEmployee = {
  id: string;
  email: string | null;
  status: CommonStatus;
};

export type MatchableAlias = {
  id: string;
  provider: Provider;
  aliasEmailNormalized: string;
  employeeId: string;
  status: CommonStatus;
  validFrom: Date;
  validTo: Date | null;
};

export type ProviderCardMatch = {
  employeeId: string | null;
  status: ProviderCardMatchStatus;
  source: ProviderCardMatchSource | null;
  reasonCode: string | null;
  aliasId: string | null;
};

export function matchProviderCard(input: {
  provider: Provider;
  email: string | null;
  forcedReasonCode?: string;
  employees: MatchableEmployee[];
  aliases?: MatchableAlias[];
  subMappedEmployeeIds?: Set<string>;
  matchingAt?: Date;
}): ProviderCardMatch {
  if (input.forcedReasonCode) {
    return unmatched(
      input.forcedReasonCode === 'MULTIPLE_CARDHOLDERS'
        ? ProviderCardMatchStatus.conflict
        : ProviderCardMatchStatus.unmatched,
      input.forcedReasonCode,
    );
  }

  const email = normalizeEmail(input.email);
  if (!email) return unmatched(ProviderCardMatchStatus.unmatched, 'CARDHOLDER_EMAIL_MISSING');
  if (!isValidEmail(email)) return unmatched(ProviderCardMatchStatus.unmatched, 'CARDHOLDER_EMAIL_INVALID');

  const primaryMatches = input.employees.filter((employee) => normalizeEmail(employee.email) === email);
  if (primaryMatches.length > 1) return unmatched(ProviderCardMatchStatus.conflict, 'EMPLOYEE_EMAIL_AMBIGUOUS');

  const matchingAt = input.matchingAt ?? new Date();
  const aliasMatches = input.provider === Provider.photonpay
    ? (input.aliases ?? []).filter((alias) => (
      alias.provider === Provider.photonpay
      && alias.status === CommonStatus.active
      && alias.aliasEmailNormalized === email
      && alias.validFrom <= matchingAt
      && (!alias.validTo || alias.validTo > matchingAt)
    ))
    : [];
  if (aliasMatches.length > 1) return unmatched(ProviderCardMatchStatus.conflict, 'PROVIDER_EMAIL_ALIAS_AMBIGUOUS');

  const primary = primaryMatches[0];
  const alias = aliasMatches[0];
  if (primary && alias && primary.id !== alias.employeeId) {
    return unmatched(ProviderCardMatchStatus.conflict, 'PRIMARY_EMAIL_ALIAS_CONFLICT');
  }

  if (primary) {
    return validateEmployeeMatch(
      primary,
      ProviderCardMatchSource.employee_primary_email,
      null,
      input.provider,
      input.subMappedEmployeeIds,
    );
  }

  if (alias) {
    const employee = input.employees.find((candidate) => candidate.id === alias.employeeId);
    if (!employee) return unmatched(ProviderCardMatchStatus.unmatched, 'EMPLOYEE_NOT_FOUND');
    return validateEmployeeMatch(
      employee,
      ProviderCardMatchSource.provider_email_alias,
      alias.id,
      input.provider,
      input.subMappedEmployeeIds,
    );
  }

  return unmatched(ProviderCardMatchStatus.unmatched, 'EMPLOYEE_NOT_FOUND');
}

function validateEmployeeMatch(
  employee: MatchableEmployee,
  source: ProviderCardMatchSource,
  aliasId: string | null,
  provider: Provider,
  subMappedEmployeeIds: Set<string> | undefined,
): ProviderCardMatch {
  if (employee.status !== CommonStatus.active) {
    return unmatched(ProviderCardMatchStatus.unmatched, 'EMPLOYEE_DISABLED');
  }
  if (provider === Provider.photonpay && !subMappedEmployeeIds?.has(employee.id)) {
    return unmatched(ProviderCardMatchStatus.unmatched, 'EMPLOYEE_WITHOUT_SUB');
  }
  return {
    employeeId: employee.id,
    status: ProviderCardMatchStatus.matched,
    source,
    reasonCode: null,
    aliasId,
  };
}

function unmatched(status: ProviderCardMatchStatus, reasonCode: string): ProviderCardMatch {
  return { employeeId: null, status, source: null, reasonCode, aliasId: null };
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase() ?? '';
  return email ? email.slice(0, 255) : null;
}

export function isValidEmail(value: string): boolean {
  return value.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function emailDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function maskEmail(value: string | null | undefined): string | null {
  const normalized = normalizeEmail(value);
  if (!normalized) return null;
  const at = normalized.indexOf('@');
  if (at <= 0) return '[invalid-email]';
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const maskedLocal = local.length <= 2 ? `${local[0] ?? '*'}*` : `${local.slice(0, 2)}***`;
  const domainParts = domain.split('.');
  const domainName = domainParts.shift() ?? '';
  const maskedDomain = `${domainName.slice(0, 1) || '*'}***${domainParts.length ? `.${domainParts.join('.')}` : ''}`;
  return `${maskedLocal}@${maskedDomain}`;
}
