import { CommonStatus, Prisma, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import { EverflowClient, EVERFLOW_API_KEY_HEADER } from './everflow-client';
import { EverflowIncomeSyncAdapter, getGmt8SettlementMonthWindow } from './everflow-income-sync.adapter';

const affiliateAccountId = '10000000-0000-0000-0000-000000000001';
const employeeId = '30000000-0000-0000-0000-000000000001';
const settlementMonth = new Date(Date.UTC(2026, 6, 1));

describe('EverflowClient aggregate reporting', () => {
  it('requests the affiliate entity table grouped by SUB1 in USD', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ table: [], summary: { revenue: 0 } }) });
    const client = new EverflowClient(fetchMock as never);
    await client.getAffiliateSubRevenueSummary({ credential: { apiKey: 'secret', baseUrl: 'https://example.test' }, from: '2026-07-01', to: '2026-07-31', timezoneId: 20, subField: 'sub1' });
    expect(fetchMock).toHaveBeenCalledWith(new URL('https://example.test/v1/affiliates/reporting/entity/table'), expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ [EVERFLOW_API_KEY_HEADER]: 'secret' }),
    }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      from: '2026-07-01', to: '2026-07-31', timezone_id: 20, currency_id: 'USD', columns: [{ column: 'sub1' }], query: { filters: [] },
    });
  });
});

describe('EverflowIncomeSyncAdapter monthly SUB revenue', () => {
  let prisma: any;
  let client: any;
  let unmatchedEvents: any;
  let adapter: EverflowIncomeSyncAdapter;

  beforeEach(() => {
    prisma = {
      affiliateAccountCredential: { findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date('2026-08-03T00:00:00Z') }) },
      auditLog: { findFirst: jest.fn().mockResolvedValue({ id: 'audit-1', createdAt: new Date('2026-08-03T00:01:00Z') }) },
      subIdMapping: { findMany: jest.fn().mockResolvedValue([{ employeeId }]) },
      incomeRecord: { upsert: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    client = { getAffiliateSubRevenueSummary: jest.fn() };
    unmatchedEvents = { recordUnmatchedEvent: jest.fn().mockResolvedValue({}) };
    adapter = new EverflowIncomeSyncAdapter(prisma, client, unmatchedEvents);
  });

  it('uses the complete GMT+8 calendar month and inclusive Everflow date fields', () => {
    expect(getGmt8SettlementMonthWindow(settlementMonth)).toMatchObject({
      from: '2026-07-01', to: '2026-07-31', timezoneId: 20,
      startInclusiveUtc: new Date('2026-06-30T16:00:00.000Z'), endExclusiveUtc: new Date('2026-07-31T16:00:00.000Z'),
    });
  });

  it('writes one monthly record per mapped SUB and routes blank revenue to unmatched', async () => {
    mockRows([
      { columns: [{ column_type: 'sub1', id: 'ZW', label: 'ZW' }], reporting: { revenue: 100 } },
      { columns: [{ column_type: 'sub1', id: '', label: '' }], reporting: { revenue: 5 } },
      { columns: [{ column_type: 'sub1', id: 'ZERO' }], reporting: { revenue: 0 } },
    ]);
    const result = await adapter.execute(context());
    expect(result.status).toBe('completed');
    expect(prisma.subIdMapping.findMany).toHaveBeenCalledWith({ where: {
      affiliateAccountId, subField: 'sub1', subValue: 'ZW', effectiveMonth: settlementMonth, status: CommonStatus.active,
    }, select: { employeeId: true } });
    expect(prisma.incomeRecord.upsert.mock.calls[0][0].create).toMatchObject({ source: 'everflow', subField: 'sub1', subValue: 'ZW', incomeUsd: new Prisma.Decimal(100), employeeId });
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'SUB_ID_MISSING', amountUsd: new Prisma.Decimal(5) }));
    expect(prisma.incomeRecord.deleteMany).toHaveBeenCalledTimes(2);
    expect(result.resultPayload).toMatchObject({ pulledCount: 3, positiveRevenueCount: 2, attributedCount: 1, unmatchedCount: 1, zeroRevenueCount: 1 });
  });

  it('fails closed on incomplete provider results before income writes', async () => {
    client.getAffiliateSubRevenueSummary.mockResolvedValue({ table: [], incomplete_results: true });
    const result = await adapter.execute(context());
    expect(result.status).toBe('failed');
    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
  });

  it('fails closed before provider access when current credentials are not calibrated', async () => {
    prisma.auditLog.findFirst.mockResolvedValue(null);
    const result = await adapter.execute(context());
    expect(result.status).toBe('failed');
    expect(client.getAffiliateSubRevenueSummary).not.toHaveBeenCalled();
  });

  function mockRows(table: Record<string, unknown>[]) {
    client.getAffiliateSubRevenueSummary.mockResolvedValue({ table, summary: { revenue: 105 }, incomplete_results: false });
  }
});

function context() {
  return {
    taskId: 'task-1', sourceType: SyncTaskSourceType.affiliate_income, taskType: SyncTaskType.affiliate_income,
    platform: SyncTaskPlatform.everflow, settlementMonth, affiliateAccountId, affiliateAccountCode: '21490', requestedBy: 'user-1',
    credential: { credentialId: 'cred-1', hasCredential: true as const, maskedPayload: {}, payload: { apiKey: 'plain-secret' } },
  };
}
