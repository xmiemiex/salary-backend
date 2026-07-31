import { CommonStatus, Prisma, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import { CAKE_DEFAULT_CONVERSIONS_PATH, CakeClient } from './cake-client';
import {
  CakeIncomeSyncAdapter,
  getCakeGmt8SettlementMonthWindow,
  normalizeCakeRecord,
} from './cake-income-sync.adapter';

const actorUserId = '00000000-0000-0000-0000-000000000001';
const affiliateAccountId = '10000000-0000-0000-0000-000000000001';
const employeeId = '30000000-0000-0000-0000-000000000001';
const settlementMonth = new Date(Date.UTC(2026, 5, 1));
const confirmedTestPolicy = {
  liveCalibrationConfirmed: true,
  payoutField: 'price' as const,
  payableDispositions: ['approved'],
  evidenceBasis: 'test_fixture_only',
};

describe('CakeClient', () => {
  it('uses accountCode as affiliate_id and reads the latest schema data/row_count response', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ row_count: 1, data: [{ conversion_id: 'cv-1' }] }),
    });
    const client = new CakeClient(fetchMock as never);

    const response = await client.getConversions({
      credential: {
        apiKey: 'test-api-key',
        baseUrl: 'https://cake.example.test/affiliates/api',
      },
      affiliateId: '329',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      startAtRow: 1,
      rowLimit: 2000,
    });

    const url = fetchMock.mock.calls[0][0] as URL;
    expect(`${url.origin}${url.pathname}`).toBe(`https://cake.example.test/affiliates/api/${CAKE_DEFAULT_CONVERSIONS_PATH}`);
    expect(url.searchParams.get('api_key')).toBe('test-api-key');
    expect(url.searchParams.get('affiliate_id')).toBe('329');
    expect(url.searchParams.getAll('fields')).toEqual(expect.arrayContaining(['conversion_id', 'subid_1', 'subid_5', 'price', 'disposition']));
    expect(response).toMatchObject({ rowCount: 1, conversions: [{ conversion_id: 'cv-1' }] });
  });

  it('uses the official read-only campaign, disposition, and currency calibration paths', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: jest.fn().mockResolvedValue({ row_count: 1, data: [{ revenue: 12 }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: jest.fn().mockResolvedValue({ row_count: 1, data: [{ disposition_type_name: 'Approved' }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: jest.fn().mockResolvedValue({ row_count: 1, data: [{ currency_name: 'US Dollar' }] }) });
    const client = new CakeClient(fetchMock as never);
    const credential = { apiKey: 'test-api-key', baseUrl: 'https://cake.example.test/affiliates/api' };

    await client.getCampaignSummary({
      credential,
      affiliateId: '329',
      startDate: '2026-07-30',
      endDate: '2026-07-31',
      rowLimit: 1000,
    });
    await client.getDispositionTypes({ credential, affiliateId: '329' });
    await client.getCurrencies({ credential, affiliateId: '329' });

    const urls = fetchMock.mock.calls.map(([url]) => url as URL);
    expect(urls.map((url) => url.pathname)).toEqual([
      '/affiliates/api/Reports/CampaignSummary',
      '/affiliates/api/Lists/DispositionTypes',
      '/affiliates/api/Lists/Currencies',
    ]);
    expect(urls.every((url) => url.searchParams.get('affiliate_id') === '329')).toBe(true);
    expect(urls[0].searchParams.getAll('fields')).toEqual(
      expect.arrayContaining(['revenue', 'currency_id', 'currency_symbol']),
    );
  });
});

describe('CakeIncomeSyncAdapter', () => {
  let prisma: {
    subIdMapping: { findMany: jest.Mock };
    incomeRecord: { upsert: jest.Mock };
  };
  let client: { getConversions: jest.Mock };
  let unmatchedEvents: { recordUnmatchedEvent: jest.Mock };
  let adapter: CakeIncomeSyncAdapter;

  beforeEach(() => {
    prisma = {
      subIdMapping: { findMany: jest.fn() },
      incomeRecord: { upsert: jest.fn().mockResolvedValue({ id: 'income-1' }) },
    };
    client = { getConversions: jest.fn() };
    unmatchedEvents = { recordUnmatchedEvent: jest.fn().mockResolvedValue({ id: 'unmatched-1' }) };
    adapter = new CakeIncomeSyncAdapter(
      prisma as never,
      client as never,
      unmatchedEvents as never,
      confirmedTestPolicy,
    );
  });

  it('fails closed before provider access or database writes when live calibration is unconfirmed', async () => {
    const blockedAdapter = new CakeIncomeSyncAdapter(prisma as never, client as never, unmatchedEvents as never);

    const result = await blockedAdapter.execute(context());

    expect(result).toMatchObject({
      status: 'failed',
      successCount: 0,
      failedCount: 1,
      resultPayload: {
        pulledCount: 0,
        payoutField: 'unconfirmed',
        payableDispositionPolicy: [],
        dispositionPolicySource: 'blocked_pending_live_calibration',
      },
    });
    expect(result.errorMessage).toContain('live payout and disposition calibration');
    expect(client.getConversions).not.toHaveBeenCalled();
    expect(prisma.subIdMapping.findMany).not.toHaveBeenCalled();
    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
  });

  it('calculates the exact GMT+8 half-open month window', () => {
    const window = getCakeGmt8SettlementMonthWindow(settlementMonth);
    expect(window.startInclusiveUtc.toISOString()).toBe('2026-05-31T16:00:00.000Z');
    expect(window.endExclusiveUtc.toISOString()).toBe('2026-06-30T16:00:00.000Z');
    expect(window).toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-30' });
  });

  it('normalizes official subid_1..5 to sub1..5 and does not let aliases override official values', () => {
    const record = normalizeCakeRecord({
      conversion_id: 'cv-1',
      conversion_date: '2026-06-01T00:00:00+08:00',
      price: 12.34,
      disposition: 'Approved',
      subid_1: 'official-1',
      sub1: 'wrong-alias',
      subid_2: 'official-2',
      subid_5: 'official-5',
    });
    expect(record.subCandidates).toEqual([
      { subField: 'sub1', subValue: 'official-1' },
      { subField: 'sub2', subValue: 'official-2' },
      { subField: 'sub5', subValue: 'official-5' },
    ]);
    expect(record.payoutUsd).toEqual(new Prisma.Decimal('12.34'));
    expect(record.payoutField).toBe('price');
    expect(record.payoutValid).toBe(true);
  });

  it('preserves existing reasonable SUB aliases when official subid fields are absent', () => {
    expect(normalizeCakeRecord({ sub_id: 329 }).subCandidates).toEqual([
      { subField: 'sub_id', subValue: '329' },
    ]);
    expect(normalizeCakeRecord({ Subid: 'legacy-sub' }).subCandidates).toEqual([
      { subField: 'subid', subValue: 'legacy-sub' },
    ]);
  });

  it('upserts approved price payout by one active SUB mapping without defaultEmployeeId fallback', async () => {
    mockConversions([conversion()]);
    prisma.subIdMapping.findMany.mockResolvedValue([{ subField: 'sub1', subValue: 'alice-sub', employeeId }]);

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ successCount: 1, failedCount: 0 });
    expect(client.getConversions).toHaveBeenCalledWith(expect.objectContaining({
      affiliateId: '329',
      credential: { apiKey: 'plain-secret', baseUrl: 'https://cake.example.test/affiliates/api', conversionsPath: undefined },
    }));
    expect(prisma.subIdMapping.findMany).toHaveBeenCalledWith({
      where: {
        affiliateAccountId,
        effectiveMonth: settlementMonth,
        status: CommonStatus.active,
        OR: [{ subField: 'sub1', subValue: 'alice-sub' }],
      },
      select: { subField: true, subValue: true, employeeId: true },
    });
    expect(prisma.incomeRecord.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { source_externalRecordId: { source: 'cake', externalRecordId: 'cv-1' } },
      create: expect.objectContaining({
        source: 'cake',
        externalRecordId: 'cv-1',
        affiliateAccountId,
        employeeId,
        settlementMonth,
        subField: 'sub1',
        subValue: 'alice-sub',
        incomeUsd: new Prisma.Decimal('12.34'),
        status: CommonStatus.confirmed,
      }),
    }));
    expect(JSON.stringify(prisma.incomeRecord.upsert.mock.calls[0][0])).not.toContain('defaultEmployeeId');
    expect(JSON.stringify(result)).not.toContain('plain-secret');
  });

  it.each([
    ['month start', '2026-06-01T00:00:00+08:00', true],
    ['month end', '2026-06-30T23:59:59+08:00', true],
    ['next month start', '2026-07-01T00:00:00+08:00', false],
    ['GMT+8 start in UTC', '2026-05-31T16:00:00Z', true],
  ])('filters %s using conversion_date, not sync execution time', async (_name, conversionDate, included) => {
    mockConversions([conversion({ conversion_date: conversionDate })]);
    prisma.subIdMapping.findMany.mockResolvedValue([{ subField: 'sub1', subValue: 'alice-sub', employeeId }]);

    const result = await adapter.execute(context());

    expect(prisma.incomeRecord.upsert).toHaveBeenCalledTimes(included ? 1 : 0);
    expect(result.resultPayload).toMatchObject({ attributedCount: included ? 1 : 0, unmatchedCount: included ? 0 : 1 });
    if (!included) expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'OUTSIDE_SETTLEMENT_WINDOW' }));
  });

  it.each([
    ['missing external id', conversion({ conversion_id: undefined }), 'EXTERNAL_ID_MISSING'],
    ['missing SUB', conversion({ subid_1: undefined }), 'SUB_ID_MISSING'],
    ['pending disposition', conversion({ disposition: 'Pending' }), 'PAYOUT_NOT_FINAL'],
    ['rejected disposition', conversion({ disposition: 'Rejected' }), 'PAYOUT_NOT_FINAL'],
    ['unknown disposition', conversion({ disposition: 'Review' }), 'DISPOSITION_UNCONFIRMED'],
    ['naive timestamp', conversion({ conversion_date: '2026-06-01 00:00:00' }), 'TIMESTAMP_TIMEZONE_UNCONFIRMED'],
    ['invalid price', conversion({ price: 'not-a-number' }), 'PAYOUT_INVALID'],
    ['unconfirmed revenue alias', conversion({ price: undefined, revenue: '12.34' }), 'PAYOUT_MISSING'],
  ])('records %s as unmatched without writing income', async (_name, raw, reasonCode) => {
    mockConversions([raw]);
    prisma.subIdMapping.findMany.mockResolvedValue([{ subField: 'sub1', subValue: 'alice-sub', employeeId }]);

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(result.resultPayload).toMatchObject({ attributedCount: 0, unmatchedCount: 1 });
    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(expect.objectContaining({ reasonCode }));
  });

  it('records no mapping as unmatched and never falls back to defaultEmployeeId', async () => {
    mockConversions([conversion()]);
    prisma.subIdMapping.findMany.mockResolvedValue([]);

    await adapter.execute(context());

    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'SUB_ID_NOT_MAPPED',
      subField: 'sub1',
      subValue: 'alice-sub',
    }));
  });

  it('records multiple SUB fields mapped to different employees as a conflict', async () => {
    mockConversions([conversion({ subid_2: 'bob-sub' })]);
    prisma.subIdMapping.findMany.mockResolvedValue([
      { subField: 'sub1', subValue: 'alice-sub', employeeId: 'employee-a' },
      { subField: 'sub2', subValue: 'bob-sub', employeeId: 'employee-b' },
    ]);

    await adapter.execute(context());

    expect(prisma.incomeRecord.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'SUB_ID_EMPLOYEE_CONFLICT' }));
  });

  it('uses source + external conversion ID upsert key for idempotency', async () => {
    mockConversions([conversion()]);
    prisma.subIdMapping.findMany.mockResolvedValue([{ subField: 'sub1', subValue: 'alice-sub', employeeId }]);

    await adapter.execute(context());
    await adapter.execute(context());

    expect(prisma.incomeRecord.upsert).toHaveBeenCalledTimes(2);
    for (const [args] of prisma.incomeRecord.upsert.mock.calls) {
      expect(args.where).toEqual({ source_externalRecordId: { source: 'cake', externalRecordId: 'cv-1' } });
    }
  });

  it('paginates and skips an overlapping conversion without double attribution', async () => {
    const firstPage = Array.from({ length: 2000 }, (_, index) => conversion({ conversion_id: `cv-${index}` }));
    client.getConversions
      .mockResolvedValueOnce({ conversions: firstPage, rowCount: 2001 })
      .mockResolvedValueOnce({ conversions: [conversion({ conversion_id: 'cv-1999' })], rowCount: 2001 });
    prisma.subIdMapping.findMany.mockResolvedValue([{ subField: 'sub1', subValue: 'alice-sub', employeeId }]);

    const result = await adapter.execute(context());

    expect(client.getConversions).toHaveBeenCalledTimes(2);
    expect(prisma.incomeRecord.upsert).toHaveBeenCalledTimes(2000);
    expect(result.resultPayload).toMatchObject({ pulledCount: 2001, attributedCount: 2000, duplicateCount: 1, pageCount: 2 });
  });

  it('redacts API Key from provider errors and result payload', async () => {
    client.getConversions.mockRejectedValue(new Error('fetch failed ?api_key=plain-secret&start_date=2026-06-01'));

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('plain-secret');
    expect(result.errorMessage).toContain('api_key=[REDACTED]');
  });

  function mockConversions(conversions: Record<string, unknown>[]) {
    client.getConversions.mockResolvedValue({ conversions, rowCount: conversions.length, raw: { data: conversions } });
  }
});

function conversion(overrides: Record<string, unknown> = {}) {
  return {
    conversion_id: 'cv-1',
    conversion_date: '2026-06-01T00:00:00+08:00',
    price: '12.34',
    disposition: 'Approved',
    subid_1: 'alice-sub',
    ...overrides,
  };
}

function context() {
  return {
    taskId: '20000000-0000-0000-0000-000000000001',
    sourceType: SyncTaskSourceType.affiliate_income,
    taskType: SyncTaskType.affiliate_income,
    platform: SyncTaskPlatform.cake,
    settlementMonth,
    affiliateAccountId,
    affiliateAccountCode: '329',
    requestedBy: actorUserId,
    credential: {
      credentialId: 'cred-1',
      hasCredential: true as const,
      maskedPayload: { apiKey: 'plai****cret' },
      payload: { apiKey: 'plain-secret', baseUrl: 'https://cake.example.test/affiliates/api' },
    },
  };
}
