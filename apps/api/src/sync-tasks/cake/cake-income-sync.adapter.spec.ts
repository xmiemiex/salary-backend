import { CommonStatus, Prisma, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import { CAKE_DEFAULT_SUBAFFILIATE_SUMMARY_PATH, CakeClient } from './cake-client';
import { CakeIncomeSyncAdapter, getCakeGmt8SettlementMonthWindow } from './cake-income-sync.adapter';

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
  let adapter: CakeIncomeSyncAdapter;

  beforeEach(() => {
    prisma = {
      affiliateAccountCredential: { findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date('2026-08-03T00:00:00Z') }) },
      auditLog: { findFirst: jest.fn().mockResolvedValue({ id: 'audit-1', createdAt: new Date('2026-08-03T00:01:00Z') }) },
      subIdMapping: { findMany: jest.fn().mockResolvedValue([{ employeeId }]) },
      incomeRecord: { upsert: jest.fn().mockResolvedValue({ id: 'income-1' }), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    client = { getSubAffiliateSummary: jest.fn() };
    unmatchedEvents = { recordUnmatchedEvent: jest.fn().mockResolvedValue({ id: 'unmatched-1' }) };
    adapter = new CakeIncomeSyncAdapter(prisma, client, unmatchedEvents);
  });

  it('uses the GMT+8 full-month half-open boundary', () => {
    expect(getCakeGmt8SettlementMonthWindow(settlementMonth)).toMatchObject({
      startDate: '2026-07-01T00:00:00', endDate: '2026-08-01T00:00:00',
      startInclusiveUtc: new Date('2026-06-30T16:00:00.000Z'), endExclusiveUtc: new Date('2026-07-31T16:00:00.000Z'),
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
    expect(prisma.subIdMapping.findMany).toHaveBeenCalledWith({ where: {
      affiliateAccountId, subField: 'sub1', subValue: 'ZW', effectiveMonth: settlementMonth, status: CommonStatus.active,
    }, select: { employeeId: true } });
    const write = prisma.incomeRecord.upsert.mock.calls[0][0];
    expect(write.create).toMatchObject({ source: 'cake', affiliateAccountId, employeeId, subField: 'sub1', subValue: 'ZW', incomeUsd: new Prisma.Decimal('77710') });
    expect(write.where.source_externalRecordId.externalRecordId).toContain(`cake:sub-month:${affiliateAccountId}:2026-07:`);
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'SUB_ID_MISSING', amountUsd: new Prisma.Decimal('195') }));
    expect(prisma.incomeRecord.deleteMany).toHaveBeenCalledTimes(2);
    expect(result.resultPayload).toMatchObject({ pulledCount: 3, positiveRevenueCount: 2, attributedCount: 1, unmatchedCount: 1, zeroRevenueCount: 1 });
    expect(JSON.stringify(result.resultPayload)).not.toContain('plain-secret');
  });

  it('fails closed before provider access and income writes without current calibration', async () => {
    prisma.auditLog.findFirst.mockResolvedValue(null);
    const result = await adapter.execute(context());
    expect(result.status).toBe('failed');
    expect(client.getSubAffiliateSummary).not.toHaveBeenCalled();
    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
  });

  it('uses a stable idempotency key across repeated runs', async () => {
    mockRows([{ sub_id: 'ZW', revenue: '10' }]);
    await adapter.execute(context());
    await adapter.execute(context());
    const first = prisma.incomeRecord.upsert.mock.calls[0][0].where;
    const second = prisma.incomeRecord.upsert.mock.calls[1][0].where;
    expect(second).toEqual(first);
  });

  it('routes multiple-employee mapping conflicts to unmatched', async () => {
    mockRows([{ sub_id: 'ZW', revenue: '10' }]);
    prisma.subIdMapping.findMany.mockResolvedValue([{ employeeId: 'emp-1' }, { employeeId: 'emp-2' }]);
    const result = await adapter.execute(context());
    expect(result.status).toBe('completed');
    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'SUB_ID_EMPLOYEE_CONFLICT' }));
  });

  function mockRows(rows: Record<string, unknown>[]) {
    client.getSubAffiliateSummary.mockResolvedValue({ rows, rowCount: rows.length, httpStatus: 200, raw: {} });
  }
});

function context() {
  return {
    taskId: '20000000-0000-0000-0000-000000000001', sourceType: SyncTaskSourceType.affiliate_income,
    taskType: SyncTaskType.affiliate_income, platform: SyncTaskPlatform.cake, settlementMonth,
    affiliateAccountId, affiliateAccountCode: '329', requestedBy: '00000000-0000-0000-0000-000000000001',
    credential: { credentialId: 'cred-1', hasCredential: true as const, maskedPayload: {}, payload: { apiKey: 'plain-secret', baseUrl: 'https://cake.test/affiliates/api' } },
  };
}
