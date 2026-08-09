import { CommonStatus, Prisma, Provider, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import {
  AIRWALLEX_API_KEY_HEADER,
  AIRWALLEX_BUSINESS_ACCOUNT_API_VERSION,
  AIRWALLEX_DEFAULT_CARDS_PATH,
  AIRWALLEX_CLIENT_ID_HEADER,
  AIRWALLEX_DEFAULT_TRANSACTIONS_PATH,
  AirwallexClient,
} from './airwallex-client';
import { AirwallexCardSyncAdapter, getAirwallexGmt8SettlementMonthWindow } from './airwallex-card-sync.adapter';

const actorUserId = '00000000-0000-0000-0000-000000000001';
const employeeId = '30000000-0000-0000-0000-000000000001';
const settlementMonth = new Date(Date.UTC(2026, 5, 1));

describe('AirwallexClient', () => {
  it('authenticates with Airwallex headers and requests all transaction events with official query fields', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ token: 'bearer-token' }) })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ items: [], total_count: 0 }) });
    const client = new AirwallexClient(fetchMock as never);

    await client.listCardTransactions({
      credential: { clientId: 'client-id', apiKey: 'api-key', baseUrl: 'https://airwallex.example.test' },
      from: new Date('2026-05-31T16:00:00.000Z'),
      to: new Date('2026-06-30T16:00:00.000Z'),
      page: 'cursor-2',
      pageSize: 200,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL('https://airwallex.example.test/api/v1/authentication/login'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          [AIRWALLEX_CLIENT_ID_HEADER]: 'client-id',
          [AIRWALLEX_API_KEY_HEADER]: 'api-key',
        }),
      }),
    );
    const url = fetchMock.mock.calls[1][0] as URL;
    expect(`${url.origin}${url.pathname}`).toBe(`https://airwallex.example.test${AIRWALLEX_DEFAULT_TRANSACTIONS_PATH}`);
    expect(url.searchParams.get('from_created_at')).toBe('2026-05-31T16:00:00.000Z');
    expect(url.searchParams.get('to_created_at')).toBe('2026-06-30T16:00:00.000Z');
    expect(url.searchParams.has('transaction_type')).toBe(false);
    expect(url.searchParams.has('status')).toBe(false);
    expect(url.searchParams.get('page')).toBe('cursor-2');
    expect(url.searchParams.get('page_size')).toBe('200');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({
        Authorization: 'Bearer bearer-token',
        'Content-Type': 'application/json',
        'x-api-version': AIRWALLEX_BUSINESS_ACCOUNT_API_VERSION,
      }),
    });
  });

  it('discovers all cards using an explicit creation range instead of the Airwallex 30-day default', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ token: 'bearer-token' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ has_more: false, items: [{ card_id: 'card-1' }] }),
      });
    const client = new AirwallexClient(fetchMock as never);

    const result = await client.listCards({
      credential: { clientId: 'client-id', apiKey: 'api-key', baseUrl: 'https://airwallex.example.test' },
      page: 0,
      pageSize: 200,
      from: new Date('2000-01-01T00:00:00.000Z'),
      to: new Date('2026-08-05T00:00:00.000Z'),
    });

    const url = fetchMock.mock.calls[1][0] as URL;
    expect(`${url.origin}${url.pathname}`).toBe(`https://airwallex.example.test${AIRWALLEX_DEFAULT_CARDS_PATH}`);
    expect(url.searchParams.get('from_created_at')).toBe('2000-01-01T00:00:00.000Z');
    expect(url.searchParams.get('to_created_at')).toBe('2026-08-05T00:00:00.000Z');
    expect(url.searchParams.get('page_num')).toBe('0');
    expect(result).toEqual({ cards: [{ card_id: 'card-1' }], hasMore: false });
  });
});

describe('AirwallexCardSyncAdapter', () => {
  let prisma: {
    cardBinding: { findFirst: jest.Mock };
    cardSpendEvent: { upsert: jest.Mock };
  };
  let client: { listCardTransactions: jest.Mock };
  let unmatchedEvents: { recordUnmatchedEvent: jest.Mock; resolveAfterSuccessfulImport: jest.Mock };
  let inventory: { syncProviderWithPayload: jest.Mock; resolveSpendOwner: jest.Mock; markTransactionSync: jest.Mock; markUntouchedTransactionSync: jest.Mock };
  let adapter: AirwallexCardSyncAdapter;

  beforeEach(() => {
    prisma = {
      cardBinding: { findFirst: jest.fn() },
      cardSpendEvent: { upsert: jest.fn().mockResolvedValue({ id: 'spend-1' }) },
    };
    client = { listCardTransactions: jest.fn() };
    unmatchedEvents = {
      recordUnmatchedEvent: jest.fn().mockResolvedValue({ id: 'unmatched-1' }),
      resolveAfterSuccessfulImport: jest.fn().mockResolvedValue(false),
    };
    inventory = {
      syncProviderWithPayload: jest.fn().mockResolvedValue({ provider: Provider.airwallex, status: 'completed', discoveredCount: 1, matchedCount: 1, unmatchedCount: 0, conflictCount: 0, retainedHistoricalCards: true }),
      resolveSpendOwner: jest.fn().mockResolvedValue({ ok: true, employeeId, subIdMapping: { id: 'sub-1', affiliateAccountId: 'account-1', subField: 'sub1', subValue: 'employee-sub' } }),
      markTransactionSync: jest.fn().mockResolvedValue(undefined),
      markUntouchedTransactionSync: jest.fn().mockResolvedValue(undefined),
    };
    adapter = new AirwallexCardSyncAdapter(prisma as never, client as never, unmatchedEvents as never, inventory as never);
  });

  it('calculates the GMT+8 settlement month window from transactionAt', () => {
    const window = getAirwallexGmt8SettlementMonthWindow(settlementMonth);

    expect(window.settlementStartInclusiveUtc.toISOString()).toBe('2026-05-31T16:00:00.000Z');
    expect(window.settlementEndExclusiveUtc.toISOString()).toBe('2026-06-30T16:00:00.000Z');
    expect(window.requestFromCreatedDate.toISOString()).toBe('2026-05-31T16:00:00.000Z');
    expect(window.requestToCreatedDate.toISOString()).toBe('2026-07-10T16:00:00.000Z');
  });

  it('upserts clearing USD transactions as confirmed card spend events by card binding', async () => {
    mockTransactions([
      {
        transaction_id: 'txn-1',
        card_id: 'card-1',
        status: 'APPROVED',
        transaction_type: 'CLEARING',
        transaction_date: '2026-06-15T12:00:00.000Z',
        billing_amount: '12.34',
        billing_currency: 'USD',
        posted_date: '2026-06-18T00:00:00.000Z',
      },
    ]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(result.successCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(client.listCardTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({
          clientId: 'plain-client-id',
          apiKey: 'plain-api-key',
          settlementDelayDays: 10,
        }),
        from: new Date('2026-05-31T16:00:00.000Z'),
        to: new Date('2026-07-10T16:00:00.000Z'),
        page: null,
      }),
    );
    expect(result.resultPayload).toMatchObject({
      requestWindow: {
        fromCreatedDate: '2026-05-31T16:00:00.000Z',
        toCreatedDate: '2026-07-10T16:00:00.000Z',
      },
      settlementWindow: {
        startInclusiveUtc: '2026-05-31T16:00:00.000Z',
        endExclusiveUtc: '2026-06-30T16:00:00.000Z',
        timezone: 'GMT+8',
      },
    });
    expect(inventory.resolveSpendOwner).toHaveBeenCalledWith(Provider.airwallex, 'card-1', settlementMonth);
    expect(prisma.cardSpendEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_externalEventId: { provider: Provider.airwallex, externalEventId: 'txn-1' } },
        create: expect.objectContaining({
          provider: Provider.airwallex,
          externalEventId: 'txn-1',
          cardId: 'card-1',
          employeeId,
          settlementMonth,
          transactionAt: new Date('2026-06-15T12:00:00.000Z'),
          amount: new Prisma.Decimal('12.34'),
          currency: 'USD',
          spendUsd: new Prisma.Decimal('12.34'),
          status: CommonStatus.confirmed,
          importedBy: actorUserId,
        }),
        update: expect.objectContaining({
          employeeId,
          amount: new Prisma.Decimal('12.34'),
          currency: 'USD',
          spendUsd: new Prisma.Decimal('12.34'),
          status: CommonStatus.confirmed,
          importedBy: actorUserId,
        }),
      }),
    );
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('plain-api-key');
    expect(JSON.stringify(result)).not.toContain('plain-client-id');
  });

  it('stores clearing spend as a positive cost when Airwallex returns a negative billing amount', async () => {
    mockTransactions([
      {
        transaction_id: 'txn-negative',
        card_id: 'card-1',
        status: 'APPROVED',
        transaction_type: 'CLEARING',
        transaction_date: '2026-06-15T12:00:00.000Z',
        billing_amount: '-12.34',
        billing_currency: 'USD',
      },
    ]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    await adapter.execute(context());

    expect(prisma.cardSpendEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ spendUsd: new Prisma.Decimal('12.34') }),
      }),
    );
  });

  it('stores refunds as negative spend so monthly card cost is not overstated', async () => {
    mockTransactions([
      {
        transaction_id: 'txn-refund',
        card_id: 'card-1',
        status: 'APPROVED',
        transaction_type: 'REFUND',
        transaction_date: '2026-06-20T12:00:00.000Z',
        billing_amount: '5.00',
        billing_currency: 'USD',
      },
    ]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    await adapter.execute(context());

    expect(prisma.cardSpendEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ spendUsd: new Prisma.Decimal('-5') }),
      }),
    );
  });

  it('writes a June transaction even when its Airwallex created_date is in July within the request delay window', async () => {
    mockTransactions([
      {
        transaction_id: 'txn-1',
        card_id: 'card-1',
        status: 'APPROVED',
        transaction_type: 'CLEARING',
        transaction_date: '2026-06-30T12:00:00.000Z',
        created_date: '2026-07-02T00:00:00.000Z',
        billing_amount: 9,
        billing_currency: 'USD',
      },
    ]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(prisma.cardSpendEvent.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.cardSpendEvent.upsert.mock.calls[0][0].create.transactionAt).toEqual(new Date('2026-06-30T12:00:00.000Z'));
  });

  it('does not write a July transaction even though the expanded Airwallex created_date request window includes July', async () => {
    mockTransactions([
      {
        transaction_id: 'txn-1',
        card_id: 'card-1',
        status: 'APPROVED',
        transaction_type: 'CLEARING',
        transaction_date: '2026-07-01T00:00:00.000Z',
        created_date: '2026-07-02T00:00:00.000Z',
        billing_amount: 9,
        billing_currency: 'USD',
      },
    ]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
  });

  it('uses credential settlementDelayDays to extend requestToCreatedDate', async () => {
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

  it('uses the default 10 day settlement delay when credential settlementDelayDays is invalid', async () => {
    mockTransactions([]);

    await adapter.execute(context({ settlementDelayDays: 99 }));

    expect(client.listCardTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        to: new Date('2026-07-10T16:00:00.000Z'),
        credential: expect.objectContaining({ settlementDelayDays: 10 }),
      }),
    );
  });

  it('also accepts card transaction status CLEARED as settled business semantics', async () => {
    mockTransactions([
      {
        transaction_id: 'txn-1',
        card_id: 'card-1',
        status: 'CLEARED',
        transaction_date: '2026-06-15T12:00:00.000Z',
        billing_amount: '12.34',
        billing_currency: 'USD',
      },
    ]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(prisma.cardSpendEvent.upsert).toHaveBeenCalledTimes(1);
  });

  it('does not write authorization, reversal, declined, expired, or verified transactions', async () => {
    mockTransactions([
      { transaction_id: 'txn-1', card_id: 'card-1', status: 'AUTHORIZED', transaction_type: 'AUTHORIZATION', transaction_date: '2026-06-15T00:00:00.000Z', billing_amount: 1, billing_currency: 'USD' },
      { transaction_id: 'txn-2', card_id: 'card-1', status: 'REVERSED', transaction_type: 'REVERSAL', transaction_date: '2026-06-15T00:00:00.000Z', billing_amount: 1, billing_currency: 'USD' },
      { transaction_id: 'txn-3', card_id: 'card-1', status: 'DECLINED', transaction_type: 'AUTHORIZATION', transaction_date: '2026-06-15T00:00:00.000Z', billing_amount: 1, billing_currency: 'USD' },
      { transaction_id: 'txn-4', card_id: 'card-1', status: 'EXPIRED', transaction_type: 'AUTHORIZATION', transaction_date: '2026-06-15T00:00:00.000Z', billing_amount: 1, billing_currency: 'USD' },
      { transaction_id: 'txn-5', card_id: 'card-1', status: 'VERIFIED', transaction_type: 'AUTHORIZATION', transaction_date: '2026-06-15T00:00:00.000Z', billing_amount: 0, billing_currency: 'USD' },
    ]);

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
  });

  it('filters settled transactions outside the GMT+8 month window without reconciliation noise', async () => {
    mockTransactions([
      { transaction_id: 'txn-1', card_id: 'card-1', transaction_type: 'CLEARING', transaction_date: '2026-05-31T15:59:59.999Z', billing_amount: 1, billing_currency: 'USD' },
      { transaction_id: 'txn-2', card_id: 'card-1', transaction_type: 'CLEARING', transaction_date: '2026-06-30T16:00:00.000Z', billing_amount: 1, billing_currency: 'USD' },
    ]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(inventory.resolveSpendOwner).not.toHaveBeenCalled();
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
  });

  it('rejects settled transactions with no active card employee mapping', async () => {
    mockTransactions([settledTransaction()]);
    inventory.resolveSpendOwner.mockResolvedValue({ ok: false, reasonCode: 'CARD_NOT_MAPPED', reasonMessage: 'not mapped' });

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

  it('rejects non-USD transactions when no FX conversion exists', async () => {
    mockTransactions([{ ...settledTransaction(), billing_currency: 'HKD' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.failedCount).toBe(1);
    expect(inventory.resolveSpendOwner).not.toHaveBeenCalled();
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
    const { card_id: _cardId, ...transactionWithoutCardId } = settledTransaction();
    mockTransactions([transactionWithoutCardId]);

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.failedCount).toBe(1);
    expect(inventory.resolveSpendOwner).not.toHaveBeenCalled();
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: SyncTaskSourceType.card_spend,
        taskType: SyncTaskType.airwallex_card,
        provider: Provider.airwallex,
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
      provider_externalEventId: { provider: Provider.airwallex, externalEventId: 'txn-1' },
    });
  });

  it('redacts credentials from result payload, message, and error message', async () => {
    client.listCardTransactions.mockRejectedValue(
      new Error('Airwallex failed for plain-client-id with plain-api-key in upstream response.'),
    );

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('plain-client-id');
    expect(JSON.stringify(result)).not.toContain('plain-api-key');
    expect(result.errorMessage).toContain('[REDACTED]');
  });

  function mockTransactions(transactions: Record<string, unknown>[]) {
    client.listCardTransactions.mockResolvedValue({ transactions, raw: { items: transactions }, hasMore: false });
  }
});

function settledTransaction() {
  return {
    transaction_id: 'txn-1',
    card_id: 'card-1',
    status: 'APPROVED',
    transaction_type: 'CLEARING',
    transaction_date: '2026-06-01T00:00:00.000Z',
    billing_amount: 1,
    billing_currency: 'USD',
  };
}

function context(payloadOverrides: Record<string, unknown> = {}) {
  return {
    taskId: '20000000-0000-0000-0000-000000000001',
    sourceType: SyncTaskSourceType.card_spend,
    taskType: SyncTaskType.airwallex_card,
    platform: SyncTaskPlatform.airwallex,
    provider: Provider.airwallex,
    settlementMonth,
    requestedBy: actorUserId,
    credential: {
      credentialId: 'cred-1',
      hasCredential: true as const,
      maskedPayload: { apiKey: 'plain****-key' },
      payload: { clientId: 'plain-client-id', apiKey: 'plain-api-key', ...payloadOverrides },
    },
  };
}
