import { CommonStatus, Prisma, Provider, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import { SyncAdapterResolver } from '../sync-adapter-resolver';
import { PhotonPayCardSyncAdapter, getPhotonPayGmt8SettlementMonthWindow } from './photonpay-card-sync.adapter';
import {
  PHOTONPAY_API_KEY_HEADER,
  PHOTONPAY_DEFAULT_TRANSACTIONS_PATH,
  PHOTONPAY_MERCHANT_ID_HEADER,
  PHOTONPAY_SIGNATURE_HEADER,
  PHOTONPAY_TIMESTAMP_HEADER,
  PhotonPayClient,
} from './photonpay-client';

const actorUserId = '00000000-0000-0000-0000-000000000001';
const employeeId = '30000000-0000-0000-0000-000000000001';
const settlementMonth = new Date(Date.UTC(2026, 5, 1));

describe('PhotonPayClient', () => {
  it('sends signed PhotonPay card transaction requests without leaking the secret', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ records: [], total: 0 }) });
    const client = new PhotonPayClient(fetchMock as never);

    await client.listCardTransactions({
      credential: {
        baseUrl: 'https://photonpay.example.test',
        apiKey: 'plain-api-key',
        secret: 'plain-secret',
        merchantId: 'merchant-1',
      },
      from: new Date('2026-05-31T16:00:00.000Z'),
      to: new Date('2026-07-10T16:00:00.000Z'),
      page: 2,
      pageSize: 200,
    });

    const url = fetchMock.mock.calls[0][0] as URL;
    const init = fetchMock.mock.calls[0][1] as { method: string; headers: Record<string, string> };
    expect(`${url.origin}${url.pathname}`).toBe(`https://photonpay.example.test${PHOTONPAY_DEFAULT_TRANSACTIONS_PATH}`);
    expect(url.searchParams.get('from')).toBe('2026-05-31T16:00:00.000Z');
    expect(url.searchParams.get('to')).toBe('2026-07-10T16:00:00.000Z');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('200');
    expect(init.method).toBe('GET');
    expect(init.headers[PHOTONPAY_API_KEY_HEADER]).toBe('plain-api-key');
    expect(init.headers[PHOTONPAY_MERCHANT_ID_HEADER]).toBe('merchant-1');
    expect(init.headers[PHOTONPAY_TIMESTAMP_HEADER]).toBe('2026-06-19T00:00:00.000Z');
    expect(init.headers[PHOTONPAY_SIGNATURE_HEADER]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(init.headers)).not.toContain('plain-secret');
    jest.useRealTimers();
  });
});

describe('PhotonPayCardSyncAdapter', () => {
  let prisma: {
    cardBinding: { findFirst: jest.Mock };
    cardSpendEvent: { upsert: jest.Mock };
  };
  let client: { listCardTransactions: jest.Mock };
  let unmatchedEvents: { recordUnmatchedEvent: jest.Mock };
  let adapter: PhotonPayCardSyncAdapter;

  beforeEach(() => {
    prisma = {
      cardBinding: { findFirst: jest.fn() },
      cardSpendEvent: { upsert: jest.fn().mockResolvedValue({ id: 'spend-1' }) },
    };
    client = { listCardTransactions: jest.fn() };
    unmatchedEvents = { recordUnmatchedEvent: jest.fn().mockResolvedValue({ id: 'unmatched-1' }) };
    adapter = new PhotonPayCardSyncAdapter(prisma as never, client as never, unmatchedEvents as never);
  });

  it('calculates requestWindow with the default 10 day settlement delay', () => {
    const window = getPhotonPayGmt8SettlementMonthWindow(settlementMonth);

    expect(window.settlementStartInclusiveUtc.toISOString()).toBe('2026-05-31T16:00:00.000Z');
    expect(window.settlementEndExclusiveUtc.toISOString()).toBe('2026-06-30T16:00:00.000Z');
    expect(window.requestFrom.toISOString()).toBe('2026-05-31T16:00:00.000Z');
    expect(window.requestTo.toISOString()).toBe('2026-07-10T16:00:00.000Z');
    expect(window.settlementDelayDays).toBe(10);
  });

  it('uses configured settlementDelayDays to extend requestWindow', async () => {
    mockTransactions([]);

    await adapter.execute(context({ settlementDelayDays: 3 }));

    expect(client.listCardTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        from: new Date('2026-05-31T16:00:00.000Z'),
        to: new Date('2026-07-03T16:00:00.000Z'),
        credential: expect.objectContaining({ settlementDelayDays: 3 }),
      }),
    );
  });

  it('falls back to the default settlementDelayDays when credential value is invalid', async () => {
    mockTransactions([]);

    const result = await adapter.execute(context({ settlementDelayDays: 99 }));

    expect(client.listCardTransactions).toHaveBeenCalledWith(expect.objectContaining({ to: new Date('2026-07-10T16:00:00.000Z') }));
    expect(result.resultPayload.settlementDelayDays).toBe(10);
  });

  it('upserts settled USD transactions as confirmed PhotonPay card spend events by card binding', async () => {
    mockTransactions([settledTransaction()]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(result.successCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.resultPayload).toMatchObject({
      adapterKey: 'card_spend.photonpay',
      provider: Provider.photonpay,
      requestWindow: { from: '2026-05-31T16:00:00.000Z', to: '2026-07-10T16:00:00.000Z' },
      settlementWindow: {
        startInclusiveUtc: '2026-05-31T16:00:00.000Z',
        endExclusiveUtc: '2026-06-30T16:00:00.000Z',
        timezone: 'GMT+8',
      },
      settlementDelayDays: 10,
    });
    expect(prisma.cardBinding.findFirst).toHaveBeenCalledWith({
      where: {
        provider: Provider.photonpay,
        cardId: 'card-1',
        effectiveMonth: settlementMonth,
        status: CommonStatus.active,
      },
      select: { employeeId: true },
    });
    expect(prisma.cardSpendEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_externalEventId: { provider: Provider.photonpay, externalEventId: 'txn-1' } },
        create: expect.objectContaining({
          provider: Provider.photonpay,
          externalEventId: 'txn-1',
          cardId: 'card-1',
          employeeId,
          settlementMonth,
          transactionAt: new Date('2026-06-15T12:00:00.000Z'),
          amount: new Prisma.Decimal('12.34'),
          currency: 'USD',
          spendUsd: new Prisma.Decimal('12.34'),
          settledAt: new Date('2026-06-20T00:00:00.000Z'),
          sourceStatus: '\u5df2\u7ed3\u7b97',
          sourceUpdatedAt: new Date('2026-07-02T00:00:00.000Z'),
          status: CommonStatus.confirmed,
          importedBy: actorUserId,
        }),
      }),
    );
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('plain-api-key');
    expect(JSON.stringify(result)).not.toContain('plain-token');
    expect(JSON.stringify(result)).not.toContain('plain-secret');
  });

  it('accepts real Chinese settleStatus 已结算 as settled', async () => {
    mockTransactions([{ ...settledTransaction(), settleStatus: '已结算' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(prisma.cardSpendEvent.upsert).toHaveBeenCalledTimes(1);
  });

  it('accepts Unicode escaped settleStatus as settled', async () => {
    mockTransactions([{ ...settledTransaction(), settleStatus: '\u5df2\u7ed3\u7b97' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(prisma.cardSpendEvent.upsert).toHaveBeenCalledTimes(1);
  });

  it.each(['settled', 'SETTLED', 'settled_success'])('accepts %s from settleStatus as settled status', async (status) => {
    mockTransactions([{ ...settledTransaction(), settleStatus: status }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(prisma.cardSpendEvent.upsert).toHaveBeenCalledTimes(1);
  });

  it('does not treat ordinary status=success as settled when settleStatus is absent', async () => {
    const { settleStatus: _settleStatus, ...transactionWithoutSettleStatus } = settledTransaction();
    mockTransactions([{ ...transactionWithoutSettleStatus, status: 'success' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(prisma.cardBinding.findFirst).not.toHaveBeenCalled();
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
  });

  it('does not write non-settled transactions', async () => {
    mockTransactions([
      { ...settledTransaction(), id: 'txn-1', settleStatus: 'pending' },
      { ...settledTransaction(), id: 'txn-2', settleStatus: 'cancel' },
      { ...settledTransaction(), id: 'txn-3', settleStatus: 'failed' },
      { ...settledTransaction(), id: 'txn-4', settleStatus: 'reversal' },
    ]);

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
  });

  it('writes an in-month transaction whose platform updated time is in the next month requestWindow', async () => {
    mockTransactions([{ ...settledTransaction(), transactionAt: '2026-06-30T12:00:00.000Z', updatedAt: '2026-07-02T00:00:00.000Z' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(prisma.cardSpendEvent.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.cardSpendEvent.upsert.mock.calls[0][0].create.transactionAt).toEqual(new Date('2026-06-30T12:00:00.000Z'));
  });

  it('does not write a next-month transaction even when requestWindow includes it', async () => {
    mockTransactions([{ ...settledTransaction(), transactionAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-02T00:00:00.000Z' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(prisma.cardBinding.findFirst).not.toHaveBeenCalled();
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'OUTSIDE_SETTLEMENT_WINDOW',
        thirdPartyEventId: 'txn-1',
        occurredAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
    );
  });

  it('rejects settled transactions with no active card binding', async () => {
    mockTransactions([settledTransaction()]);
    prisma.cardBinding.findFirst.mockResolvedValue(null);

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.failedCount).toBe(1);
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'CARD_NOT_MAPPED',
        cardId: 'card-1',
        thirdPartyEventId: 'txn-1',
      }),
    );
  });

  it('rejects non-USD transactions without writing or converting FX', async () => {
    mockTransactions([{ ...settledTransaction(), currency: 'HKD' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.failedCount).toBe(1);
    expect(prisma.cardBinding.findFirst).not.toHaveBeenCalled();
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'INVALID_CURRENCY',
        currency: 'HKD',
        amountUsd: null,
      }),
    );
  });

  it('records settled transactions missing cardId as unmatched', async () => {
    const { cardId: _cardId, ...transactionWithoutCardId } = settledTransaction();
    mockTransactions([transactionWithoutCardId]);

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.failedCount).toBe(1);
    expect(prisma.cardBinding.findFirst).not.toHaveBeenCalled();
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: SyncTaskSourceType.card_spend,
        taskType: SyncTaskType.photonpay_card,
        provider: Provider.photonpay,
        syncTaskId: context().taskId,
        reasonCode: 'CARD_ID_MISSING',
        thirdPartyEventId: 'txn-1',
      }),
    );
  });

  it('uses provider + externalEventId upsert to avoid duplicate imports', async () => {
    mockTransactions([settledTransaction()]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    await adapter.execute(context());

    expect(prisma.cardSpendEvent.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.cardSpendEvent.upsert.mock.calls[0][0].where).toEqual({
      provider_externalEventId: { provider: Provider.photonpay, externalEventId: 'txn-1' },
    });
  });

  it('redacts plaintext credentials from resultPayload, message, and errorMessage', async () => {
    client.listCardTransactions.mockRejectedValue(
      new Error('PhotonPay failed with plain-api-key plain-token plain-secret merchant-1 in upstream response.'),
    );

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('plain-api-key');
    expect(JSON.stringify(result)).not.toContain('plain-token');
    expect(JSON.stringify(result)).not.toContain('plain-secret');
    expect(JSON.stringify(result)).not.toContain('merchant-1');
    expect(result.errorMessage).toContain('[REDACTED]');
  });

  function mockTransactions(transactions: Record<string, unknown>[]) {
    client.listCardTransactions.mockResolvedValue({ transactions, raw: { records: transactions }, hasMore: false });
  }
});

describe('SyncAdapterResolver PhotonPay routing', () => {
  it('routes PhotonPay and Airwallex card spend to their real adapters', () => {
    const airwallex = { adapterKey: 'card_spend.airwallex' };
    const photonpay = { adapterKey: 'card_spend.photonpay' };
    const resolver = new SyncAdapterResolver(
      { adapterKey: 'affiliate_income.everflow' } as never,
      { adapterKey: 'affiliate_income.cake' } as never,
      airwallex as never,
      photonpay as never,
    );

    expect(resolver.resolve({ sourceType: SyncTaskSourceType.card_spend, provider: Provider.airwallex })).toBe(airwallex);
    expect(resolver.resolve({ sourceType: SyncTaskSourceType.card_spend, provider: Provider.photonpay })).toBe(photonpay);
  });
});

function settledTransaction() {
  return {
    id: 'txn-1',
    cardId: 'card-1',
    settleStatus: '\u5df2\u7ed3\u7b97',
    transactionAt: '2026-06-15T12:00:00.000Z',
    amount: '12.34',
    currency: 'USD',
    settledAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  };
}

function context(payloadOverrides: Record<string, unknown> = {}) {
  return {
    taskId: '20000000-0000-0000-0000-000000000001',
    sourceType: SyncTaskSourceType.card_spend,
    taskType: SyncTaskType.photonpay_card,
    platform: SyncTaskPlatform.photonpay,
    provider: Provider.photonpay,
    settlementMonth,
    requestedBy: actorUserId,
    credential: {
      credentialId: 'cred-1',
      hasCredential: true as const,
      maskedPayload: { apiKey: 'plain****-key' },
      payload: {
        apiKey: 'plain-api-key',
        token: 'plain-token',
        secret: 'plain-secret',
        merchantId: 'merchant-1',
        ...payloadOverrides,
      },
    },
  };
}
