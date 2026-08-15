import { CommonStatus } from '@prisma/client';
import {
  EffectiveSubIdMapping,
  isUsableEffectiveSubIdMapping,
  resolveEffectiveSubIdMappings,
} from './effective-sub-id-mappings';

describe('resolveEffectiveSubIdMappings', () => {
  const june = new Date('2026-06-01T00:00:00.000Z');
  const july = new Date('2026-07-01T00:00:00.000Z');
  const august = new Date('2026-08-01T00:00:00.000Z');
  const september = new Date('2026-09-01T00:00:00.000Z');
  let reader: any;

  beforeEach(() => {
    reader = { subIdMapping: { findMany: jest.fn() } };
  });

  it.each([
    ['same month', june],
    ['next month', july],
    ['two months later', august],
  ])('carries a June active mapping into the %s', async (_label, settlementMonth) => {
    reader.subIdMapping.findMany.mockResolvedValue([mapping({ effectiveMonth: june })]);
    const result = await resolve(settlementMonth);
    expect(result).toHaveLength(1);
    expect(result[0].employeeId).toBe('employee-old');
    expect(reader.subIdMapping.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ effectiveMonth: { lte: settlementMonth } }),
    }));
  });

  it('selects the nearest version without letting a future version affect history', async () => {
    reader.subIdMapping.findMany.mockResolvedValue([
      mapping({ id: 'new', employeeId: 'employee-new', effectiveMonth: september }),
      mapping({ id: 'old', employeeId: 'employee-old', effectiveMonth: june }),
    ]);
    await expect(resolve(september)).resolves.toMatchObject([{ id: 'new', employeeId: 'employee-new' }]);

    reader.subIdMapping.findMany.mockResolvedValue([mapping({ id: 'old', employeeId: 'employee-old', effectiveMonth: june })]);
    await expect(resolve(august)).resolves.toMatchObject([{ id: 'old', employeeId: 'employee-old' }]);
  });

  it('keeps a latest disabled version so consumers cannot fall back to an older active mapping', async () => {
    reader.subIdMapping.findMany.mockResolvedValue([
      mapping({ id: 'disabled', effectiveMonth: september, status: CommonStatus.disabled }),
      mapping({ id: 'old', effectiveMonth: june, status: CommonStatus.active }),
    ]);
    const result = await resolve(september);
    expect(result).toMatchObject([{ id: 'disabled', status: CommonStatus.disabled }]);
    expect(result.some(isUsableEffectiveSubIdMapping)).toBe(false);
    expect(reader.subIdMapping.findMany.mock.calls[0][0].where.status).toBeUndefined();
  });

  it('marks a mapping to a disabled employee unusable without falling back', async () => {
    reader.subIdMapping.findMany.mockResolvedValue([
      mapping({ id: 'new', employeeId: 'employee-disabled', effectiveMonth: september, employeeStatus: CommonStatus.disabled }),
      mapping({ id: 'old', employeeId: 'employee-old', effectiveMonth: june }),
    ]);
    const result = await resolve(september);
    expect(result).toHaveLength(1);
    expect(result[0].employeeId).toBe('employee-disabled');
    expect(isUsableEffectiveSubIdMapping(result[0])).toBe(false);
  });

  it('scopes identical SUB values by affiliate account and supports legal multi-account employee mappings', async () => {
    reader.subIdMapping.findMany.mockResolvedValue([
      mapping({ id: 'account-a', affiliateAccountId: 'account-a', employeeId: 'employee-shared' }),
      mapping({ id: 'account-b', affiliateAccountId: 'account-b', employeeId: 'employee-shared' }),
    ]);
    const all = await resolveEffectiveSubIdMappings(reader, { settlementMonth: july, employeeId: 'employee-shared' });
    expect(all.map((item) => item.affiliateAccountId).sort()).toEqual(['account-a', 'account-b']);

    reader.subIdMapping.findMany.mockResolvedValue([
      mapping({ id: 'account-a', affiliateAccountId: 'account-a', employeeId: 'employee-a' }),
    ]);
    const scoped = await resolveEffectiveSubIdMappings(reader, {
      settlementMonth: july, affiliateAccountId: 'account-a', subField: 'sub1', subValue: 'ZW',
    });
    expect(scoped).toMatchObject([{ affiliateAccountId: 'account-a', employeeId: 'employee-a' }]);
  });

  async function resolve(settlementMonth: Date) {
    return resolveEffectiveSubIdMappings(reader, {
      settlementMonth, affiliateAccountId: 'account-a', subField: 'sub1', subValue: 'ZW',
    });
  }
});

function mapping(overrides: Partial<ReturnType<typeof baseMapping>> & { employeeStatus?: CommonStatus } = {}) {
  const { employeeStatus = CommonStatus.active, ...rest } = overrides;
  return { ...baseMapping(), ...rest, employee: { ...baseMapping().employee, status: employeeStatus } };
}

function baseMapping(): EffectiveSubIdMapping {
  return {
    id: 'old',
    affiliateAccountId: 'account-a',
    subField: 'sub1',
    subValue: 'ZW',
    effectiveMonth: new Date('2026-06-01T00:00:00.000Z'),
    employeeId: 'employee-old',
    status: CommonStatus.active,
    employee: { employeeCode: '01', name: 'Employee', status: CommonStatus.active },
  };
}
