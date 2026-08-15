import { CommonStatus, Prisma, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import { CAKE_DEFAULT_SUBAFFILIATE_SUMMARY_PATH, CakeClient } from './cake-client';
import {
  CAKE_MONTHLY_SUB_CALIBRATION_ACTION,
  CakeIncomeSyncAdapter,
  getCakeProviderDefaultSettlementMonthWindow,
} from './cake-income-sync.adapter';

const affiliateAccountId = '10000000-0000-0000-0000-000000000001';
const employeeId = '30000000-0000-0000-0000-000000000001';
const settlementMonth = new Date(Date.UTC(2026, 6, 1));

describe('CakeClient SubAffiliateSummary', () => {
  it('requests the official aggregate report without exposing the key in returned data', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: jest.fn().mockResolvedValue([]) });
    const client = new CakeClient(fetchMock as never);
    await client.getSubAffiliateSummary({
      credential: { apiKey: 'secret-key', baseUrl: 'https://cake.test/affiliates/api' },
      affiliateId: '329', startDate: '2026-07-01T00:00:00', endDate: '2026-08-01T00:00:00',
    });
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.pathname).toContain(CAKE_DEFAULT_SUBAFFILIATE_SUMMARY_PATH);
    expect(url.searchParams.get('affiliate_id')).toBe('329');
    expect(url.searchParams.get('offer_id')).toBe('0');
  });

  it('accepts the official V1 XML response without returning the raw document', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue('<ArrayOfSubAffiliate><SubAffiliate><sub_id>ZW</sub_id><revenue>77710.00</revenue></SubAffiliate><SubAffiliate><sub_id /><revenue>195.00</revenue></SubAffiliate></ArrayOfSubAffiliate>'),
    });
    const client = new CakeClient(fetchMock as never);
    const result = await client.getSubAffiliateSummary({
      credential: { apiKey: 'secret-key', baseUrl: 'https://cake.test/affiliates/api' },
      affiliateId: '329', startDate: '2026-07-01T00:00:00', endDate: '2026-08-01T00:00:00',
    });
    expect(result.rows).toEqual([{ sub_id: 'ZW', impressions: '', clicks: '', conversions: '', conversion_rate: '', revenue: '77710.00', epc: '' }, { sub_id: '', impressions: '', clicks: '', conversions: '', conversion_rate: '', revenue: '195.00', epc: '' }]);
  });
});

describe('CakeIncomeSyncAdapter monthly SUB revenue', () => {
  let prisma: any;
  let client: any;
  let unmatchedEvents: any;
  let audit: any;
  let adapter: CakeIncomeSyncAdapter;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback(prisma)),
      affiliateAccountCredential: { findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date('2026-08-03T00:00:00Z') }) },
      auditLog: { findFirst: jest.fn().mockResolvedValue({ id: 'audit-1', action: CAKE_MONTHLY_SUB_CALIBRATION_ACTION, createdAt: new Date('2026-08-03T00:01:00Z') }) },
      subIdMapping: { findMany: jest.fn().mockResolvedValue([subMapping()]) },
      incomeRecord: {
        upsert: jest.fn().mockResolvedValue({ id: 'income-1' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ id: 'adjustment-1' }),
      },
    };
    client = { getSubAffiliateSummary: jest.fn() };
    unmatchedEvents = { recordUnmatchedEvent: jest.fn().mockResolvedValue({ id: 'unmatched-1' }) };
    audit = { success: jest.fn().mockResolvedValue({ id: 'audit-stale-1' }) };
    adapter = new CakeIncomeSyncAdapter(prisma, client, unmatchedEvents, audit);
  });

  it('uses the provider-default full-month half-open boundary without claiming GMT+8', () => {
    expect(getCakeProviderDefaultSettlementMonthWindow(settlementMonth)).toMatchObject({
      startDate: '2026-07-01T00:00:00', endDate: '2026-08-01T00:00:00',
      providerTimezone: 'cake_system_default', requestedSettlementTimezone: 'Asia/Shanghai',
    });
  });

  it('writes mapped positive revenue, records blank positive revenue unmatched, and skips zero revenue', async () => {
    mockRows([
      { sub_id: 'ZW', revenue: '77710' },
      { sub_id: '', revenue: '195' },
      { sub_id: 'RRR', revenue: '0' },
    ]);
    const result = await adapter.execute(context());
    expect(result.status).toBe('completed');
    expect(result.successCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(prisma.subIdMapping.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      affiliateAccountId, subField: 'sub1', subValue: 'ZW', effectiveMonth: { lte: settlementMonth },
    }, orderBy: { effectiveMonth: 'desc' } }));
    const write = prisma.incomeRecord.upsert.mock.calls[0][0];
    expect(write.create).toMatchObject({ source: 'cake', affiliateAccountId, employeeId, subField: 'sub1', subValue: 'ZW', incomeUsd: new Prisma.Decimal('77710') });
    expect(write.where.source_externalRecordId.externalRecordId).toContain(`cake:sub-month:${affiliateAccountId}:2026-07:`);
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'SUB_ID_MISSING', amountUsd: new Prisma.Decimal('195') }), prisma);
    expect(prisma.incomeRecord.deleteMany).toHaveBeenCalledTimes(2);
    expect(result.resultPayload).toMatchObject({ pulledCount: 3, positiveRevenueCount: 2, attributedCount: 1, unmatchedCount: 1, zeroRevenueCount: 1 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.resultPayload)).not.toContain('plain-secret');
  });

  it('fails closed before provider access and income writes without current calibration', async () => {
    prisma.auditLog.findFirst.mockResolvedValue(null);
    const result = await adapter.execute(context());
    expect(result.status).toBe('failed');
    expect(client.getSubAffiliateSummary).not.toHaveBeenCalled();
    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
  });

  it('fails closed when the newest calibration is a read-only mismatch even if an older pass exists', async () => {
    prisma.auditLog.findFirst.mockResolvedValue({ id: 'audit-2', action: 'cake.monthly_sub_revenue.calibration.read', createdAt: new Date('2026-08-04T00:01:00Z') });
    const result = await adapter.execute(context());
    expect(result.status).toBe('failed');
    expect(client.getSubAffiliateSummary).not.toHaveBeenCalled();
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { createdAt: 'desc' },
      where: expect.objectContaining({ action: { in: expect.arrayContaining([CAKE_MONTHLY_SUB_CALIBRATION_ACTION, 'cake.monthly_sub_revenue.calibration.read']) } }),
    }));
  });

  it('uses a stable idempotency key across repeated runs', async () => {
    mockRows([{ sub_id: 'ZW', revenue: '10' }]);
    await adapter.execute(context());
    await adapter.execute(context());
    const first = prisma.incomeRecord.upsert.mock.calls[0][0].where;
    const second = prisma.incomeRecord.upsert.mock.calls[1][0].where;
    expect(second).toEqual(first);
  });

  it('reproduces BA2 July and attributes four positive rows through June mappings while skipping one zero row', async () => {
    mockRows([
      { sub_id: 'YDF', revenue: '100' },
      { sub_id: 'MSY', revenue: '200' },
      { sub_id: 'DAN', revenue: '300' },
      { sub_id: 'ZW', revenue: '400' },
      { sub_id: 'ZERO', revenue: '0' },
    ]);
    const result = await adapter.execute({ ...context(), affiliateAccountCode: '3284' });
    expect(result.status).toBe('completed');
    expect(result.resultPayload).toMatchObject({
      pulledCount: 5,
      aggregateRowCount: 5,
      positiveRevenueCount: 4,
      attributedCount: 4,
      unmatchedCount: 0,
      zeroRevenueCount: 1,
    });
    expect(prisma.incomeRecord.upsert).toHaveBeenCalledTimes(4);
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
  });

  it('fails the sync when any write inside the monthly transaction fails', async () => {
    mockRows([{ sub_id: 'ZW', revenue: '10' }, { sub_id: 'YDF', revenue: '20' }]);
    prisma.incomeRecord.upsert.mockResolvedValueOnce({ id: 'income-1' }).mockRejectedValueOnce(new Error('simulated write failure'));
    const result = await adapter.execute(context());
    expect(result.status).toBe('failed');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.errorMessage).toContain('simulated write failure');
  });

  it('marks a confirmed adjustment stale with audit when a later API sync changes the base', async () => {
    mockRows([{ sub_id: 'ZW', revenue: '77385' }]);
    prisma.incomeRecord.findUnique.mockResolvedValue({
      id: 'adjustment-1',
      status: CommonStatus.confirmed,
      incomeUsd: new Prisma.Decimal('325'),
      rawData: {
        kind: 'cake_sub_revenue_adjustment', basis: 'manual_china_standard_time',
        providerTimezone: 'cake_system_default', settlementTimezone: 'Asia/Shanghai',
        baseRevenueUsd: '77000', targetRevenueUsd: '77710', adjustmentUsd: '710', reason: 'Portal核对', stale: false,
      },
    });
    await adapter.execute(context());
    expect(prisma.incomeRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'adjustment-1' },
      data: expect.objectContaining({ incomeUsd: new Prisma.Decimal('325'), status: CommonStatus.draft }),
    }));
    expect(prisma.incomeRecord.update.mock.calls[0][0].data.rawData).toMatchObject({
      stale: true, staleReason: 'cake_base_revenue_changed', previousBaseRevenueUsd: '77000', currentBaseRevenueUsd: '77385',
    });
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: 'cake_income_adjustment.base_changed_stale' }), prisma);
  });

  it('does not touch an adjustment when repeated API sync keeps the same base', async () => {
    mockRows([{ sub_id: 'ZW', revenue: '77385' }]);
    prisma.incomeRecord.findUnique.mockResolvedValue({
      id: 'adjustment-1', status: CommonStatus.confirmed, incomeUsd: new Prisma.Decimal('325'),
      rawData: {
        kind: 'cake_sub_revenue_adjustment', basis: 'manual_china_standard_time',
        providerTimezone: 'cake_system_default', settlementTimezone: 'Asia/Shanghai',
        baseRevenueUsd: '77385', targetRevenueUsd: '77710', adjustmentUsd: '325', reason: 'Portal核对', stale: false,
      },
    });
    await adapter.execute(context());
    expect(prisma.incomeRecord.update).not.toHaveBeenCalled();
    expect(audit.success).not.toHaveBeenCalled();
  });

  it('routes multiple-employee mapping conflicts to unmatched', async () => {
    mockRows([{ sub_id: 'ZW', revenue: '10' }]);
    prisma.subIdMapping.findMany.mockResolvedValue([
      subMapping({ id: 'mapping-1', employeeId: 'emp-1' }),
      subMapping({ id: 'mapping-2', employeeId: 'emp-2' }),
    ]);
    const result = await adapter.execute(context());
    expect(result.status).toBe('completed');
    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'SUB_ID_EMPLOYEE_CONFLICT' }), prisma);
  });

  it('does not fall back when the latest mapping is disabled and rejects a disabled employee', async () => {
    mockRows([{ sub_id: 'ZW', revenue: '10' }]);
    prisma.subIdMapping.findMany.mockResolvedValueOnce([
      subMapping({ id: 'disabled', effectiveMonth: new Date('2026-07-01T00:00:00.000Z'), status: CommonStatus.disabled }),
      subMapping({ id: 'old', effectiveMonth: new Date('2026-06-01T00:00:00.000Z') }),
    ]);
    await adapter.execute(context());
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenLastCalledWith(expect.objectContaining({ reasonCode: 'SUB_ID_NOT_MAPPED' }), prisma);

    prisma.subIdMapping.findMany.mockResolvedValueOnce([subMapping({ employeeStatus: CommonStatus.disabled })]);
    await adapter.execute(context());
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenLastCalledWith(expect.objectContaining({ reasonCode: 'EMPLOYEE_DISABLED' }), prisma);
  });

  function mockRows(rows: Record<string, unknown>[]) {
    client.getSubAffiliateSummary.mockResolvedValue({ rows, rowCount: rows.length, httpStatus: 200, raw: {} });
  }
});

function subMapping(overrides: Record<string, unknown> & { employeeStatus?: CommonStatus } = {}) {
  const { employeeStatus = CommonStatus.active, ...rest } = overrides;
  return {
    id: 'mapping-1', affiliateAccountId, subField: 'sub1', subValue: 'ZW',
    effectiveMonth: new Date('2026-06-01T00:00:00.000Z'), employeeId, status: CommonStatus.active,
    employee: { employeeCode: '01', name: 'Employee', status: employeeStatus },
    ...rest,
  };
}

function context() {
  return {
    taskId: '20000000-0000-0000-0000-000000000001', sourceType: SyncTaskSourceType.affiliate_income,
    taskType: SyncTaskType.affiliate_income, platform: SyncTaskPlatform.cake, settlementMonth,
    affiliateAccountId, affiliateAccountCode: '329', requestedBy: '00000000-0000-0000-0000-000000000001',
    credential: { credentialId: 'cred-1', hasCredential: true as const, maskedPayload: {}, payload: { apiKey: 'plain-secret', baseUrl: 'https://cake.test/affiliates/api' } },
  };
}
