import { CommonStatus, Prisma, Provider } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { MonthLockService } from '../month-lock/month-lock.service';
import { CardBindingsService } from '../card-bindings/card-bindings.service';
import { EmployeesService } from '../employees/employees.service';
import { MonthlyCardProviderFeeRatesService } from '../monthly-card-provider-fee-rates/monthly-card-provider-fee-rates.service';
import { MonthlyExchangeRatesService } from '../monthly-exchange-rates/monthly-exchange-rates.service';
import { SubIdMappingsService } from '../sub-id-mappings/sub-id-mappings.service';

describe('base data management services', () => {
  const actor = { userId: '00000000-0000-0000-0000-000000000001', roleCode: 'finance' };
  const settlementMonth = new Date('2026-05-01T00:00:00.000Z');

  function duplicateError() {
    return new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    });
  }

  function createHarness() {
    const prisma = {
      employee: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      subIdMapping: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      cardBinding: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      monthlyExchangeRate: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      monthlyCardProviderFeeRate: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const audit = {
      success: jest.fn().mockResolvedValue(undefined),
      failure: jest.fn().mockResolvedValue(undefined),
    };
    const monthLock = {
      assertWritable: jest.fn().mockResolvedValue(undefined),
    };
    return {
      prisma,
      audit,
      monthLock,
      employees: new EmployeesService(prisma as never, audit as unknown as AuditService),
      subIdMappings: new SubIdMappingsService(
        prisma as never,
        monthLock as unknown as MonthLockService,
        audit as unknown as AuditService,
      ),
      cardBindings: new CardBindingsService(
        prisma as never,
        monthLock as unknown as MonthLockService,
        audit as unknown as AuditService,
      ),
      exchangeRates: new MonthlyExchangeRatesService(
        prisma as never,
        monthLock as unknown as MonthLockService,
        audit as unknown as AuditService,
      ),
      feeRates: new MonthlyCardProviderFeeRatesService(
        prisma as never,
        monthLock as unknown as MonthLockService,
        audit as unknown as AuditService,
      ),
    };
  }

  it('creates employee with unique employeeCode and writes success audit', async () => {
    const { employees, prisma, audit } = createHarness();
    prisma.employee.create.mockResolvedValue({
      id: 'emp-1',
      employeeCode: 'E001',
      name: 'Alice',
      status: CommonStatus.active,
    });

    await employees.create({ employeeCode: 'E001', name: 'Alice' }, actor);

    expect(prisma.employee.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ employeeCode: 'E001', name: 'Alice' }),
    });
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'employee.create',
        objectType: 'employees',
        objectId: 'emp-1',
        afterData: expect.objectContaining({ employeeCode: 'E001' }),
      }),
    );
  });

  it('rejects duplicate employeeCode without success audit and writes failure audit', async () => {
    const { employees, prisma, audit } = createHarness();
    prisma.employee.create.mockRejectedValue(duplicateError());

    await expect(employees.create({ employeeCode: 'E001', name: 'Alice' }, actor)).rejects.toMatchObject({
      code: ERROR_CODES.DUPLICATE_RESOURCE,
    });

    expect(audit.success).not.toHaveBeenCalled();
    expect(audit.failure).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'employee.create',
        failureReason: ERROR_CODES.DUPLICATE_RESOURCE,
      }),
    );
  });

  it('creates sub id mapping after lock check, audits success, and rejects duplicate key', async () => {
    const { subIdMappings, prisma, monthLock, audit } = createHarness();
    prisma.subIdMapping.create.mockResolvedValue({
      id: 'map-1',
      affiliateAccountId: 'acct-1',
      subField: 'sub1',
      subValue: 'abc',
      effectiveMonth: settlementMonth,
      employeeId: 'emp-1',
      status: CommonStatus.active,
    });

    await subIdMappings.create(
      {
        affiliateAccountId: 'acct-1',
        subField: 'sub1',
        subValue: 'abc',
        effectiveMonth: '2026-05-01',
        employeeId: 'emp-1',
      },
      actor,
    );

    expect(monthLock.assertWritable).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementMonth,
        action: 'sub_id_mapping.create',
        objectType: 'sub_id_mappings',
      }),
      actor,
    );
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sub_id_mapping.create',
        settlementMonth,
        changedFields: expect.arrayContaining(['affiliateAccountId', 'effectiveMonth', 'employeeId']),
      }),
    );

    prisma.subIdMapping.create.mockRejectedValueOnce(duplicateError());
    await expect(
      subIdMappings.create(
        {
          affiliateAccountId: 'acct-1',
          subField: 'sub1',
          subValue: 'abc',
          effectiveMonth: settlementMonth,
          employeeId: 'emp-1',
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.DUPLICATE_RESOURCE });
  });

  it('rejects sub id mapping update for locked month without database write or duplicate failure audit', async () => {
    const { subIdMappings, prisma, monthLock, audit } = createHarness();
    const lockedError = new AppError(ERROR_CODES.MONTH_LOCKED, 'locked');
    prisma.subIdMapping.findUnique.mockResolvedValue({
      id: 'map-1',
      effectiveMonth: settlementMonth,
      status: CommonStatus.active,
    });
    monthLock.assertWritable.mockRejectedValue(lockedError);

    await expect(subIdMappings.update('map-1', { employeeId: 'emp-2' }, actor)).rejects.toBe(lockedError);

    expect(prisma.subIdMapping.update).not.toHaveBeenCalled();
    expect(audit.failure).not.toHaveBeenCalled();
  });

  it('creates card binding with provider + cardId + effectiveMonth unique shape and lock check', async () => {
    const { cardBindings, prisma, monthLock } = createHarness();
    prisma.cardBinding.create.mockResolvedValue({
      id: 'card-binding-1',
      provider: Provider.airwallex,
      cardId: 'card-1',
      effectiveMonth: settlementMonth,
      employeeId: 'emp-1',
    });

    await cardBindings.create(
      { provider: Provider.airwallex, cardId: 'card-1', effectiveMonth: '2026-05-01', employeeId: 'emp-1' },
      actor,
    );

    expect(monthLock.assertWritable).toHaveBeenCalledWith(
      expect.objectContaining({ settlementMonth, action: 'card_binding.create' }),
      actor,
    );
    expect(prisma.cardBinding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: Provider.airwallex,
        cardId: 'card-1',
        effectiveMonth: settlementMonth,
      }),
    });

    prisma.cardBinding.create.mockRejectedValueOnce(duplicateError());
    await expect(
      cardBindings.create(
        { provider: Provider.airwallex, cardId: 'card-1', effectiveMonth: settlementMonth, employeeId: 'emp-1' },
        actor,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.DUPLICATE_RESOURCE });
  });

  it('creates and updates monthly exchange rate with Decimal from string and rejects locked month', async () => {
    const { exchangeRates, prisma, monthLock } = createHarness();
    prisma.monthlyExchangeRate.create.mockResolvedValue({
      id: 'rate-1',
      settlementMonth,
      usdToRmbRate: new Prisma.Decimal('7.12345678'),
    });
    prisma.monthlyExchangeRate.findUnique.mockResolvedValue({
      id: 'rate-1',
      settlementMonth,
      usdToRmbRate: new Prisma.Decimal('7.1'),
    });
    prisma.monthlyExchangeRate.update.mockResolvedValue({
      id: 'rate-1',
      settlementMonth,
      usdToRmbRate: new Prisma.Decimal('7.2'),
    });

    await exchangeRates.create({ settlementMonth: '2026-05-01', usdToRmbRate: '7.12345678' }, actor);
    expect(prisma.monthlyExchangeRate.create.mock.calls[0][0].data.usdToRmbRate).toBeInstanceOf(Prisma.Decimal);
    expect(prisma.monthlyExchangeRate.create.mock.calls[0][0].data.usdToRmbRate.toString()).toBe('7.12345678');

    await exchangeRates.update('rate-1', { usdToRmbRate: '7.2' }, actor);
    expect(prisma.monthlyExchangeRate.update.mock.calls[0][0].data.usdToRmbRate).toBeInstanceOf(Prisma.Decimal);

    const lockedError = new AppError(ERROR_CODES.MONTH_LOCKED, 'locked');
    monthLock.assertWritable.mockRejectedValueOnce(lockedError);
    await expect(exchangeRates.create({ settlementMonth: '2026-05-01', usdToRmbRate: '7.1' }, actor)).rejects.toBe(lockedError);
  });

  it('creates and updates monthly card provider fee rate as actual value and rejects locked month', async () => {
    const { feeRates, prisma, monthLock } = createHarness();
    prisma.monthlyCardProviderFeeRate.create.mockResolvedValue({
      id: 'fee-1',
      settlementMonth,
      provider: Provider.photonpay,
      feeRate: new Prisma.Decimal('0.03'),
    });
    prisma.monthlyCardProviderFeeRate.findUnique.mockResolvedValue({
      id: 'fee-1',
      settlementMonth,
      provider: Provider.photonpay,
      feeRate: new Prisma.Decimal('0.02'),
    });
    prisma.monthlyCardProviderFeeRate.update.mockResolvedValue({
      id: 'fee-1',
      settlementMonth,
      provider: Provider.photonpay,
      feeRate: new Prisma.Decimal('0.03'),
    });

    await feeRates.create({ settlementMonth: '2026-05-01', provider: Provider.photonpay, feeRate: '0.03' }, actor);
    expect(prisma.monthlyCardProviderFeeRate.create.mock.calls[0][0].data.feeRate.toString()).toBe('0.03');

    await feeRates.update('fee-1', { feeRate: '0.03' }, actor);
    expect(prisma.monthlyCardProviderFeeRate.update.mock.calls[0][0].data.feeRate.toString()).toBe('0.03');

    prisma.monthlyCardProviderFeeRate.create.mockRejectedValueOnce(duplicateError());
    await expect(
      feeRates.create({ settlementMonth: '2026-05-01', provider: Provider.photonpay, feeRate: '0.03' }, actor),
    ).rejects.toMatchObject({ code: ERROR_CODES.DUPLICATE_RESOURCE });

    const lockedError = new AppError(ERROR_CODES.MONTH_LOCKED, 'locked');
    monthLock.assertWritable.mockRejectedValueOnce(lockedError);
    await expect(
      feeRates.create({ settlementMonth: '2026-05-01', provider: Provider.airwallex, feeRate: '0.03' }, actor),
    ).rejects.toBe(lockedError);
  });

  it('disables without physical delete and blocks disable for locked month scoped data', async () => {
    const { subIdMappings, prisma, monthLock, audit } = createHarness();
    prisma.subIdMapping.findUnique.mockResolvedValue({
      id: 'map-1',
      effectiveMonth: settlementMonth,
      status: CommonStatus.active,
    });
    prisma.subIdMapping.update.mockResolvedValue({
      id: 'map-1',
      effectiveMonth: settlementMonth,
      status: CommonStatus.disabled,
    });

    await subIdMappings.disable('map-1', actor);
    expect(prisma.subIdMapping.update).toHaveBeenCalledWith({
      where: { id: 'map-1' },
      data: { status: CommonStatus.disabled },
    });
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sub_id_mapping.disable',
        beforeData: expect.objectContaining({ status: CommonStatus.active }),
        afterData: expect.objectContaining({ status: CommonStatus.disabled }),
        changedFields: ['status'],
      }),
    );

    prisma.subIdMapping.update.mockClear();
    const lockedError = new AppError(ERROR_CODES.MONTH_LOCKED, 'locked');
    monthLock.assertWritable.mockRejectedValueOnce(lockedError);
    await expect(subIdMappings.disable('map-1', actor)).rejects.toBe(lockedError);
    expect(prisma.subIdMapping.update).not.toHaveBeenCalled();
  });

  it('validates month start dates', async () => {
    const { exchangeRates, prisma } = createHarness();
    prisma.monthlyExchangeRate.create.mockResolvedValue({ id: 'rate-1', settlementMonth });

    await expect(exchangeRates.create({ settlementMonth: '2026-05-15', usdToRmbRate: '7.1' }, actor)).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
    });

    await expect(exchangeRates.create({ settlementMonth: '2026-05-01', usdToRmbRate: '7.1' }, actor)).resolves.toEqual(
      expect.objectContaining({ id: 'rate-1' }),
    );
  });
});
