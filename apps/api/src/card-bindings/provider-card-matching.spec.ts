import {
  CommonStatus,
  Provider,
  ProviderCardMatchSource,
  ProviderCardMatchStatus,
} from '@prisma/client';
import { matchProviderCard, normalizeEmail } from './provider-card-matching';

const active = CommonStatus.active;
const now = new Date('2026-08-21T00:00:00.000Z');
const subMappedEmployeeIds = new Set(['employee-1', 'employee-2']);

describe('provider card matching', () => {
  it('normalizes email without fuzzy matching', () => {
    expect(normalizeEmail('  User@Example.Test ')).toBe('user@example.test');
    expect(normalizeEmail('')).toBeNull();
  });

  it('uses the employee primary email first', () => {
    const result = matchProviderCard({
      provider: Provider.photonpay,
      email: 'USER@example.test',
      employees: [{ id: 'employee-1', email: 'user@example.test', status: active }],
      aliases: [],
      subMappedEmployeeIds,
      matchingAt: now,
    });
    expect(result).toEqual({
      employeeId: 'employee-1',
      status: ProviderCardMatchStatus.matched,
      source: ProviderCardMatchSource.employee_primary_email,
      reasonCode: null,
      aliasId: null,
    });
  });

  it('falls back to an active PhotonPay alias', () => {
    const result = matchProviderCard({
      provider: Provider.photonpay,
      email: 'old@example.test',
      employees: [{ id: 'employee-1', email: 'current@example.test', status: active }],
      aliases: [alias('alias-1', 'employee-1')],
      subMappedEmployeeIds,
      matchingAt: now,
    });
    expect(result).toMatchObject({
      employeeId: 'employee-1',
      status: ProviderCardMatchStatus.matched,
      source: ProviderCardMatchSource.provider_email_alias,
      aliasId: 'alias-1',
    });
  });

  it('reports a conflict when primary email and alias point to different employees', () => {
    const result = matchProviderCard({
      provider: Provider.photonpay,
      email: 'old@example.test',
      employees: [
        { id: 'employee-1', email: 'old@example.test', status: active },
        { id: 'employee-2', email: 'current@example.test', status: active },
      ],
      aliases: [alias('alias-1', 'employee-2')],
      subMappedEmployeeIds,
      matchingAt: now,
    });
    expect(result).toMatchObject({ employeeId: null, status: ProviderCardMatchStatus.conflict, reasonCode: 'PRIMARY_EMAIL_ALIAS_CONFLICT' });
  });

  it('reports a conflict when multiple aliases are effective', () => {
    const result = matchProviderCard({
      provider: Provider.photonpay,
      email: 'old@example.test',
      employees: [
        { id: 'employee-1', email: null, status: active },
        { id: 'employee-2', email: null, status: active },
      ],
      aliases: [alias('alias-1', 'employee-1'), alias('alias-2', 'employee-2')],
      subMappedEmployeeIds,
      matchingAt: now,
    });
    expect(result).toMatchObject({ status: ProviderCardMatchStatus.conflict, reasonCode: 'PROVIDER_EMAIL_ALIAS_AMBIGUOUS' });
  });

  it('does not use a disabled or expired alias', () => {
    const disabled = { ...alias('alias-1', 'employee-1'), status: CommonStatus.disabled };
    const expired = { ...alias('alias-2', 'employee-1'), validTo: new Date('2026-08-20T00:00:00.000Z') };
    for (const candidate of [disabled, expired]) {
      expect(matchProviderCard({
        provider: Provider.photonpay,
        email: 'old@example.test',
        employees: [{ id: 'employee-1', email: null, status: active }],
        aliases: [candidate],
        subMappedEmployeeIds,
        matchingAt: now,
      })).toMatchObject({ status: ProviderCardMatchStatus.unmatched, reasonCode: 'EMPLOYEE_NOT_FOUND' });
    }
  });

  it('keeps disabled employees and employees without a current SUB mapping unmatched', () => {
    expect(matchProviderCard({
      provider: Provider.photonpay,
      email: 'old@example.test',
      employees: [{ id: 'employee-1', email: null, status: CommonStatus.disabled }],
      aliases: [alias('alias-1', 'employee-1')],
      subMappedEmployeeIds,
      matchingAt: now,
    })).toMatchObject({ reasonCode: 'EMPLOYEE_DISABLED' });
    expect(matchProviderCard({
      provider: Provider.photonpay,
      email: 'old@example.test',
      employees: [{ id: 'employee-1', email: null, status: active }],
      aliases: [alias('alias-1', 'employee-1')],
      subMappedEmployeeIds: new Set(),
      matchingAt: now,
    })).toMatchObject({ reasonCode: 'EMPLOYEE_WITHOUT_SUB' });
  });

  it('does not apply PhotonPay aliases or SUB requirements to Airwallex', () => {
    const result = matchProviderCard({
      provider: Provider.airwallex,
      email: 'user@example.test',
      employees: [{ id: 'employee-1', email: 'user@example.test', status: active }],
      aliases: [alias('alias-1', 'employee-2')],
      subMappedEmployeeIds: new Set(),
      matchingAt: now,
    });
    expect(result).toMatchObject({ status: ProviderCardMatchStatus.matched, employeeId: 'employee-1' });
  });
});

function alias(id: string, employeeId: string) {
  return {
    id,
    provider: Provider.photonpay,
    aliasEmailNormalized: 'old@example.test',
    employeeId,
    status: active,
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validTo: null,
  };
}
