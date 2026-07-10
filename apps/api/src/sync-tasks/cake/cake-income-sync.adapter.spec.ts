import { CommonStatus, Prisma, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import { CAKE_DEFAULT_CONVERSIONS_PATH, CakeClient } from './cake-client';
import { CakeIncomeSyncAdapter, getCakeGmt8SettlementMonthWindow } from './cake-income-sync.adapter';

const actorUserId = '00000000-0000-0000-0000-000000000001';
const affiliateAccountId = '10000000-0000-0000-0000-000000000001';
const employeeId = '30000000-0000-0000-0000-000000000001';
const settlementMonth = new Date(Date.UTC(2026, 5, 1));

describe('CakeClient', () => {
  it('requests CAKE conversions with configured path and api_key query auth', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ conversions: [] }),
    });
    const client = new CakeClient(fetchMock as never);

    await client.getConversions({
      credential: {
        apiKey: 'test-api-key',
        baseUrl: 'https://cake.example.test',
        conversionsPath: '/api/1/reports.asmx/Conversions',
        affiliateId: '123',
      },
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      startAtRow: 1,
      rowLimit: 2000,
    });

    const url = fetchMock.mock.calls[0][0] as URL;
    expect(`${url.origin}${url.pathname}`).toBe(`https://cake.example.test${CAKE_DEFAULT_CONVERSIONS_PATH}`);
    expect(url.searchParams.get('api_key')).toBe('test-api-key');
    expect(url.searchParams.get('start_date')).toBe('2026-06-01');
    expect(url.searchParams.get('end_date')).toBe('2026-06-30');
    expect(url.searchParams.get('start_at_row')).toBe('1');
    expect(url.searchParams.get('row_limit')).toBe('2000');
    expect(url.searchParams.get('response_format')).toBe('json');
    expect(url.searchParams.get('affiliate_id')).toBe('123');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Accept: 'application/json' } });
  });
});

describe('CakeIncomeSyncAdapter', () => {
  let prisma: {
    subIdMapping: { findFirst: jest.Mock };
    incomeRecord: { upsert: jest.Mock };
  };
  let client: { getConversions: jest.Mock };
  let unmatchedEvents: { recordUnmatchedEvent: jest.Mock };
  let adapter: CakeIncomeSyncAdapter;

  beforeEach(() => {
    prisma = {
      subIdMapping: { findFirst: jest.fn() },
      incomeRecord: { upsert: jest.fn().mockResolvedValue({ id: 'income-1' }) },
    };
    client = { getConversions: jest.fn() };
    unmatchedEvents = { recordUnmatchedEvent: jest.fn().mockResolvedValue({ id: 'unmatched-1' }) };
    adapter = new CakeIncomeSyncAdapter(prisma as never, client as never, unmatchedEvents as never);
  });

  it('calculates the GMT+8 settlement month window and CAKE date request fields', () => {
    const window = getCakeGmt8SettlementMonthWindow(settlementMonth);

    expect(window.startInclusiveUtc.toISOString()).toBe('2026-05-31T16:00:00.000Z');
    expect(window.endExclusiveUtc.toISOString()).toBe('2026-06-30T16:00:00.000Z');
    expect(window).toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-30' });
  });

  it('upserts USD records as confirmed income records by SUB mapping', async () => {
    mockConversions([{ conversion_id: 'cv-1', revenue: 12.34, currency: 'USD', sub_id: 'alice-sub' }]);
    prisma.subIdMapping.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(result.successCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(client.getConversions).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: { apiKey: 'plain-secret', baseUrl: 'https://cake.example.test', conversionsPath: undefined, affiliateId: undefined, campaignId: undefined, offerId: undefined },
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      }),
    );
    expect(prisma.subIdMapping.findFirst).toHaveBeenCalledWith({
      where: {
        affiliateAccountId,
        subField: 'sub_id',
        subValue: 'alice-sub',
        effectiveMonth: settlementMonth,
        status: CommonStatus.active,
      },
      select: { employeeId: true },
    });
    expect(prisma.incomeRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { source_externalRecordId: { source: 'cake', externalRecordId: 'cv-1' } },
        create: expect.objectContaining({
          source: 'cake',
          externalRecordId: 'cv-1',
          affiliateAccountId,
          employeeId,
          settlementMonth,
          subField: 'sub_id',
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
    ['non-USD record', { conversion_id: 'cv-1', revenue: 12.34, currency: 'EUR', sub_id: 's1' }, 'INVALID_CURRENCY'],
    ['missing externalRecordId', { revenue: 12.34, currency: 'USD', sub_id: 's1' }, 'UNKNOWN'],
    ['missing subField/subValue', { conversion_id: 'cv-1', revenue: 12.34, currency: 'USD' }, 'SUB_ID_MISSING'],
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
        platform: SyncTaskPlatform.cake,
        affiliateAccountId,
        syncTaskId: context().taskId,
        reasonCode,
      }),
    );
  });

  it('rejects records when no active SUB mapping is found', async () => {
    mockConversions([{ conversion_id: 'cv-1', revenue: 12.34, currency: 'USD', sub_id: 'missing' }]);
    prisma.subIdMapping.findFirst.mockResolvedValue(null);

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.failedCount).toBe(1);
    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'SUB_ID_NOT_MAPPED',
        subField: 'sub_id',
        subValue: 'missing',
        thirdPartyEventId: 'cv-1',
      }),
    );
  });

  it('uses upsert so existing source + externalRecordId updates instead of creating duplicates', async () => {
    mockConversions([{ conversion_id: 'cv-1', revenue: '99.01', currency: 'USD', sub1: 's1' }]);
    prisma.subIdMapping.findFirst.mockResolvedValue({ employeeId });

    await adapter.execute(context());

    expect(prisma.incomeRecord.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.incomeRecord.upsert.mock.calls[0][0].where).toEqual({
      source_externalRecordId: { source: 'cake', externalRecordId: 'cv-1' },
    });
  });

  it('keeps apiKey out of resultPayload and error fields', async () => {
    mockConversions([{ conversion_id: 'cv-1', revenue: 1, currency: 'USD', sub_id: 's1' }]);
    prisma.subIdMapping.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(JSON.stringify(result)).not.toContain('plain-secret');
  });

  it('redacts apiKey from thrown CAKE error messages', async () => {
    client.getConversions.mockRejectedValue(new Error('fetch failed https://cake.example.test/api?api_key=plain-secret&start_date=2026-06-01'));

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('plain-secret');
    expect(result.errorMessage).toContain('api_key=[REDACTED]');
  });

  function mockConversions(conversions: Record<string, unknown>[]) {
    client.getConversions.mockResolvedValue({ conversions, raw: { conversions } });
  }
});

function context() {
  return {
    taskId: '20000000-0000-0000-0000-000000000001',
    sourceType: SyncTaskSourceType.affiliate_income,
    taskType: SyncTaskType.affiliate_income,
    platform: SyncTaskPlatform.cake,
    settlementMonth,
    affiliateAccountId,
    requestedBy: actorUserId,
    credential: {
      credentialId: 'cred-1',
      hasCredential: true as const,
      maskedPayload: { apiKey: 'plain****cret' },
      payload: { apiKey: 'plain-secret', baseUrl: 'https://cake.example.test' },
    },
  };
}
