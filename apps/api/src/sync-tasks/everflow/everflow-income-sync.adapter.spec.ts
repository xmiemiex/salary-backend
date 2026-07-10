import { CommonStatus, Prisma, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import { EverflowClient, EVERFLOW_API_KEY_HEADER } from './everflow-client';
import { EverflowIncomeSyncAdapter, getGmt8SettlementMonthWindow } from './everflow-income-sync.adapter';

const actorUserId = '00000000-0000-0000-0000-000000000001';
const affiliateAccountId = '10000000-0000-0000-0000-000000000001';
const employeeId = '30000000-0000-0000-0000-000000000001';
const settlementMonth = new Date(Date.UTC(2026, 5, 1));

describe('EverflowClient', () => {
  it('requests Everflow affiliate conversions with the official API key header', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ conversions: [], paging: { page: 1, page_size: 2000, total_count: 0 } }),
    });
    const client = new EverflowClient(fetchMock as never);

    await client.searchAffiliateConversions({
      credential: { apiKey: 'test-api-key', baseUrl: 'https://example.test' },
      from: '2026-06-01',
      to: '2026-06-30',
      timezoneId: 20,
      page: 1,
      pageSize: 2000,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://example.test/v1/affiliates/reporting/conversions'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          [EVERFLOW_API_KEY_HEADER]: 'test-api-key',
        }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      from: '2026-06-01',
      to: '2026-06-30',
      timezone_id: 20,
      show_conversions: true,
      show_events: false,
      page: 1,
      page_size: 2000,
    });
  });
});

describe('EverflowIncomeSyncAdapter', () => {
  let prisma: {
    subIdMapping: { findFirst: jest.Mock };
    incomeRecord: { upsert: jest.Mock };
  };
  let client: { searchAffiliateConversions: jest.Mock };
  let unmatchedEvents: { recordUnmatchedEvent: jest.Mock };
  let adapter: EverflowIncomeSyncAdapter;

  beforeEach(() => {
    prisma = {
      subIdMapping: { findFirst: jest.fn() },
      incomeRecord: { upsert: jest.fn().mockResolvedValue({ id: 'income-1' }) },
    };
    client = { searchAffiliateConversions: jest.fn() };
    unmatchedEvents = { recordUnmatchedEvent: jest.fn().mockResolvedValue({ id: 'unmatched-1' }) };
    adapter = new EverflowIncomeSyncAdapter(prisma as never, client as never, unmatchedEvents as never);
  });

  it('calculates the GMT+8 settlement month window and Everflow date request fields', () => {
    const window = getGmt8SettlementMonthWindow(settlementMonth);

    expect(window.startInclusiveUtc.toISOString()).toBe('2026-05-31T16:00:00.000Z');
    expect(window.endExclusiveUtc.toISOString()).toBe('2026-06-30T16:00:00.000Z');
    expect(window).toMatchObject({ from: '2026-06-01', to: '2026-06-30', timezoneId: 20 });
  });

  it('upserts USD records as confirmed income records by SUB mapping', async () => {
    mockConversions([{ conversion_id: 'cv-1', transaction_id: 'tx-1', revenue: 12.34, currency_id: 'USD', sub2: 'alice-sub' }]);
    prisma.subIdMapping.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(result.successCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(client.searchAffiliateConversions).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: { apiKey: 'plain-secret', baseUrl: undefined },
        from: '2026-06-01',
        to: '2026-06-30',
        timezoneId: 20,
      }),
    );
    expect(prisma.subIdMapping.findFirst).toHaveBeenCalledWith({
      where: {
        affiliateAccountId,
        subField: 'sub2',
        subValue: 'alice-sub',
        effectiveMonth: settlementMonth,
        status: CommonStatus.active,
      },
      select: { employeeId: true },
    });
    expect(prisma.incomeRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { source_externalRecordId: { source: 'everflow', externalRecordId: 'cv-1' } },
        create: expect.objectContaining({
          source: 'everflow',
          externalRecordId: 'cv-1',
          affiliateAccountId,
          employeeId,
          settlementMonth,
          subField: 'sub2',
          subValue: 'alice-sub',
          incomeUsd: new Prisma.Decimal(12.34),
          status: CommonStatus.confirmed,
          importedBy: actorUserId,
        }),
        update: expect.objectContaining({
          employeeId,
          status: CommonStatus.confirmed,
        }),
      }),
    );
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
    expect(JSON.stringify(result.resultPayload)).not.toContain('plain-secret');
  });

  it.each([
    ['non-USD record', { conversion_id: 'cv-1', revenue: 12.34, currency_id: 'EUR', sub1: 's1' }, 'INVALID_CURRENCY'],
    ['missing externalRecordId', { revenue: 12.34, currency_id: 'USD', sub1: 's1' }, 'UNKNOWN'],
    ['missing subField/subValue', { conversion_id: 'cv-1', revenue: 12.34, currency_id: 'USD' }, 'SUB_ID_MISSING'],
  ])('records %s as unmatched without writing income', async (_name, raw, reasonCode) => {
    mockConversions([raw]);
    prisma.subIdMapping.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementMonth,
        sourceType: SyncTaskSourceType.affiliate_income,
        taskType: SyncTaskType.affiliate_income,
        platform: SyncTaskPlatform.everflow,
        affiliateAccountId,
        syncTaskId: context().taskId,
        reasonCode,
      }),
    );
  });

  it('rejects records when no active SUB mapping is found', async () => {
    mockConversions([{ conversion_id: 'cv-1', revenue: 12.34, currency_id: 'USD', sub1: 'missing' }]);
    prisma.subIdMapping.findFirst.mockResolvedValue(null);

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.failedCount).toBe(1);
    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'SUB_ID_NOT_MAPPED',
        subField: 'sub1',
        subValue: 'missing',
        thirdPartyEventId: 'cv-1',
        amountUsd: new Prisma.Decimal(12.34),
      }),
    );
  });

  it('only writes whitelisted rawSafeData fields for unmatched records', async () => {
    mockConversions([{ conversion_id: 'cv-1', revenue: 12.34, currency_id: 'EUR', sub1: 's1', apiKey: 'secret', token: 'token' }]);

    await adapter.execute(context());

    const rawSafeData = unmatchedEvents.recordUnmatchedEvent.mock.calls[0][0].rawSafeData;
    expect(rawSafeData).toMatchObject({ conversionId: 'cv-1', sub1: 's1', currency: 'EUR', amount: '12.34' });
    expect(JSON.stringify(rawSafeData)).not.toContain('secret');
    expect(JSON.stringify(rawSafeData)).not.toContain('token');
  });

  it('uses upsert so existing source + externalRecordId updates instead of creating duplicates', async () => {
    mockConversions([{ conversion_id: 'cv-1', revenue: '99.01', currency_id: 'USD', sub1: 's1' }]);
    prisma.subIdMapping.findFirst.mockResolvedValue({ employeeId });

    await adapter.execute(context());

    expect(prisma.incomeRecord.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.incomeRecord.upsert.mock.calls[0][0].where).toEqual({
      source_externalRecordId: { source: 'everflow', externalRecordId: 'cv-1' },
    });
  });

  it('returns failed with statistics when records are partially rejected', async () => {
    mockConversions([
      { conversion_id: 'cv-1', revenue: 1, currency_id: 'USD', sub1: 's1' },
      { conversion_id: 'cv-2', revenue: 1, currency_id: 'EUR', sub1: 's1' },
    ]);
    prisma.subIdMapping.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.successCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.message).toContain('successCount=1, failedCount=1');
    expect(result.errorMessage).toContain('successCount=1, failedCount=1');
  });

  function mockConversions(conversions: Record<string, unknown>[]) {
    client.searchAffiliateConversions.mockResolvedValue({
      conversions,
      paging: { page: 1, page_size: 2000, total_count: conversions.length },
    });
  }
});

function context() {
  return {
    taskId: '20000000-0000-0000-0000-000000000001',
    sourceType: SyncTaskSourceType.affiliate_income,
    taskType: SyncTaskType.affiliate_income,
    platform: SyncTaskPlatform.everflow,
    settlementMonth,
    affiliateAccountId,
    requestedBy: actorUserId,
    credential: {
      credentialId: 'cred-1',
      hasCredential: true as const,
      maskedPayload: { apiKey: 'plain****cret' },
      payload: { apiKey: 'plain-secret' },
    },
  };
}
