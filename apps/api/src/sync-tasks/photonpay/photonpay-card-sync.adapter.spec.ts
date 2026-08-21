import { CommonStatus, Prisma, Provider, SyncExecutionErrorCategory, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import { SyncAdapterResolver } from '../sync-adapter-resolver';
import {
  PhotonPayCardSyncAdapter,
  getPhotonPayGmt8SettlementMonthWindow,
  normalizePhotonPayTransaction,
  parsePhotonPayVerificationWindow,
  splitPhotonPayQueryWindow,
} from './photonpay-card-sync.adapter';
import {
  PHOTONPAY_DEFAULT_BASE_URL,
  PHOTONPAY_DEFAULT_TOKEN_PATH,
  PHOTONPAY_DEFAULT_TRANSACTIONS_PATH,
  PHOTONPAY_TOKEN_HEADER,
  PhotonPayClient,
} from './photonpay-client';

const actorUserId = '00000000-0000-0000-0000-000000000001';
const employeeId = '30000000-0000-0000-0000-000000000001';
const settlementMonth = new Date(Date.UTC(2026, 5, 1));

describe('PhotonPayClient', () => {
  it('uses the official production token URL, slash-delimited Basic credential, and v4 transaction paging fields', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ code: '0000', data: { accessToken: 'access-token', expiresIn: 1800 } }) })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ code: '0000', data: [], total: 0 }) });
    const client = new PhotonPayClient(fetchMock as never);

    await client.listCardTransactions({
      credential: {
        appId: 'plain-app-id',
        appSecret: 'plain-app-secret',
      },
      from: new Date('2026-05-31T16:00:00.000Z'),
      to: new Date('2026-07-10T16:00:00.000Z'),
      page: 2,
      pageSize: 200,
    });

    const authUrl = fetchMock.mock.calls[0][0] as URL;
    const authInit = fetchMock.mock.calls[0][1] as { method: string; headers: Record<string, string> };
    expect(authUrl.toString()).toBe(`${PHOTONPAY_DEFAULT_BASE_URL}${PHOTONPAY_DEFAULT_TOKEN_PATH}`);
    expect(authInit.method).toBe('POST');
    expect(authInit.headers['Content-Type']).toBe('application/json');
    expect(authInit.headers.Authorization).toMatch(/^basic /);
    const decodedAuthorization = Buffer.from(authInit.headers.Authorization.replace(/^basic /, ''), 'base64').toString('utf8');
    expect(decodedAuthorization).toBe('plain-app-id/plain-app-secret');
    expect(decodedAuthorization).not.toBe('plain-app-id:plain-app-secret');
    const url = fetchMock.mock.calls[1][0] as URL;
    const init = fetchMock.mock.calls[1][1] as { method: string; headers: Record<string, string> };
    expect(`${url.origin}${url.pathname}`).toBe(`${PHOTONPAY_DEFAULT_BASE_URL}${PHOTONPAY_DEFAULT_TRANSACTIONS_PATH}`);
    expect(url.searchParams.get('createdAtStart')).toBe('2026-05-31T16:00:00');
    expect(url.searchParams.get('createdAtEnd')).toBe('2026-07-10T16:00:00');
    expect(url.searchParams.get('pageIndex')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('200');
    expect(init.method).toBe('GET');
    expect(init.headers[PHOTONPAY_TOKEN_HEADER]).toBe('access-token');
    expect(client.getSafeDiagnostics()).toMatchObject({
      authenticationRequestCount: 1,
      transactionListRequestCount: 1,
      lastAuth: { httpStatus: 200, providerCode: '0000', accessGranted: true },
    });
    jest.useRealTimers();
  });

  it('never returns full cardNo from the official card detail response', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ code: '0000', data: { accessToken: 'access-token' } }) })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ code: '0000', data: { cardId: 'card-1', cardNo: 'sensitive-card-value', maskCardNo: '****1234', email: 'user@example.test' } }) });
    const client = new PhotonPayClient(fetchMock as never);
    const detail = await client.getCardDetail({ credential: { appId: 'app-id', appSecret: 'app-secret' }, cardId: 'card-1' });
    expect(detail).toMatchObject({ cardId: 'card-1', maskCardNo: '****1234', email: 'user@example.test' });
    expect(JSON.stringify(detail)).not.toContain('sensitive-card-value');
    expect(detail).not.toHaveProperty('cardNo');
    const detailInit = fetchMock.mock.calls[1][1] as { headers: Record<string, string> };
    expect(detailInit.headers[PHOTONPAY_TOKEN_HEADER]).toBe('access-token');
  });

  it('preserves PhotonPay business code and request ID while redacting credential and token echoes', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ code: '0000', data: { accessToken: 'access-token' } }) })
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ code: 'VCC_403', message: 'product unavailable access-token', requestId: 'req-photon' }),
      });
    const client = new PhotonPayClient(fetchMock as never);
    let caught: unknown;
    try {
      await client.listCards({ credential: { appId: 'app-id', appSecret: 'app-secret' }, page: 1, pageSize: 200 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ providerCode: 'VCC_403', requestId: 'req-photon' });
    expect(JSON.stringify({
      message: caught instanceof Error ? caught.message : caught,
      providerMessage: (caught as { providerMessage?: string })?.providerMessage,
    })).not.toContain('access-token');
    expect((caught as { providerMessage?: string }).providerMessage).toContain('[REDACTED]');
    const listInit = fetchMock.mock.calls[1][1] as { headers: Record<string, string> };
    expect(listInit.headers[PHOTONPAY_TOKEN_HEADER]).toBe('access-token');
  });

  it('accepts code=0000 with data.token and preserves an explicitly configured baseUrl', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ code: '0000', data: { token: 'token-from-data' } }) })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ code: '0000', data: [], total: 0 }) });
    const client = new PhotonPayClient(fetchMock as never);

    await client.listCards({
      credential: { baseUrl: 'https://configured.photonpay.example.test', appId: 'app-id', appSecret: 'app-secret' },
      page: 1,
      pageSize: 200,
    });

    expect((fetchMock.mock.calls[0][0] as URL).toString()).toBe(
      `https://configured.photonpay.example.test${PHOTONPAY_DEFAULT_TOKEN_PATH}`,
    );
    expect((fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers[PHOTONPAY_TOKEN_HEADER]).toBe('token-from-data');
  });

  it('classifies non-0000 token responses safely without credential, Authorization, or token leakage', async () => {
    const appId = 'sensitive-app-id';
    const appSecret = 'sensitive-app-secret';
    const encoded = Buffer.from(`${appId}/${appSecret}`, 'utf8').toString('base64');
    const fetchMock = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue({
        code: 'union-oauth2:21312',
        msg: `invalid ${appId} ${appSecret} ${encoded} basic ${encoded}`,
        requestId: 'safe-request-id',
      }),
    });
    const client = new PhotonPayClient(fetchMock as never);

    let caught: unknown;
    try {
      await client.listCards({ credential: { appId, appSecret }, page: 1, pageSize: 200 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      category: SyncExecutionErrorCategory.CREDENTIAL_INVALID,
      httpStatus: 200,
      providerCode: 'union-oauth2:21312',
      requestId: 'safe-request-id',
    });
    const serialized = JSON.stringify({
      message: caught instanceof Error ? caught.message : caught,
      providerMessage: (caught as { providerMessage?: string })?.providerMessage,
      providerCode: (caught as { providerCode?: string })?.providerCode,
      requestId: (caught as { requestId?: string })?.requestId,
    });
    for (const sensitive of [appId, appSecret, encoded, `basic ${encoded}`]) expect(serialized).not.toContain(sensitive);
    expect(serialized).toContain('[REDACTED]');
  });

  it('caches the token before expiry and refreshes it after the safety window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ code: '0000', data: { accessToken: 'token-1', expiresIn: 120 } }) })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ code: '0000', data: [], total: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ code: '0000', data: [], total: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ code: '0000', data: { accessToken: 'token-2', expiresIn: 120 } }) })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ code: '0000', data: [], total: 0 }) });
    const client = new PhotonPayClient(fetchMock as never);
    const credential = { appId: 'app-id', appSecret: 'app-secret' };

    await client.listCards({ credential, page: 1, pageSize: 20 });
    jest.advanceTimersByTime(59_000);
    await client.listCards({ credential, page: 1, pageSize: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(2_000);
    await client.listCards({ credential, page: 1, pageSize: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect((fetchMock.mock.calls[4][1] as { headers: Record<string, string> }).headers[PHOTONPAY_TOKEN_HEADER]).toBe('token-2');
    jest.useRealTimers();
  });

  it('reuses a token for equivalent credential objects and keeps the default lifetime beyond 30 minutes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(okJson({ code: '0000', data: { accessToken: 'stable-token' } }))
      .mockResolvedValueOnce(okJson({ code: '0000', data: [], total: 0 }))
      .mockResolvedValueOnce(okJson({ code: '0000', data: [], total: 0 }));
    const client = new PhotonPayClient(fetchMock as never);

    await client.listCards({ credential: { appId: 'same-app', appSecret: 'same-secret' }, page: 1, pageSize: 20 });
    jest.advanceTimersByTime(31 * 60 * 1_000);
    await client.listCards({ credential: { appId: 'same-app', appSecret: 'same-secret' }, page: 1, pageSize: 20 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => (url as URL).pathname === PHOTONPAY_DEFAULT_TOKEN_PATH)).toHaveLength(1);
    expect(client.getSafeDiagnostics()).toMatchObject({ authenticationRequestCount: 1, authenticationCacheHitCount: 1, cardListRequestCount: 2 });
    jest.useRealTimers();
  });

  it('blocks non-production hosts and non-allowlisted paths in production before any request', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const fetchMock = jest.fn();
    const client = new PhotonPayClient(fetchMock as never);
    try {
      await expect(client.listCards({
        credential: { baseUrl: 'https://x-api.sandbox.photontech.cc', appId: 'app', appSecret: 'secret' },
        page: 1,
        pageSize: 20,
      })).rejects.toThrow('official production API host');
      await expect(client.listCards({
        credential: { appId: 'app', appSecret: 'secret', cardsPath: '/vcc/openApi/v4/getCvv' },
        page: 1,
        pageSize: 20,
      })).rejects.toThrow('not allowlisted');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('does not share tokens across environments or appIds', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(okJson({ code: '0000', data: { accessToken: 'uat-token' } }))
      .mockResolvedValueOnce(okJson({ code: '0000', data: [], total: 0 }))
      .mockResolvedValueOnce(okJson({ code: '0000', data: { accessToken: 'production-token' } }))
      .mockResolvedValueOnce(okJson({ code: '0000', data: [], total: 0 }))
      .mockResolvedValueOnce(okJson({ code: '0000', data: { accessToken: 'other-app-token' } }))
      .mockResolvedValueOnce(okJson({ code: '0000', data: [], total: 0 }));
    const client = new PhotonPayClient(fetchMock as never);

    await client.listCards({
      credential: { baseUrl: 'https://x-api1.uat.photontech.cc', appId: 'app-a', appSecret: 'same-secret' },
      page: 1,
      pageSize: 20,
    });
    await client.listCards({ credential: { appId: 'app-a', appSecret: 'same-secret' }, page: 1, pageSize: 20 });
    await client.listCards({ credential: { appId: 'app-b', appSecret: 'same-secret' }, page: 1, pageSize: 20 });

    expect(fetchMock.mock.calls.filter(([, init]) => (init as { method?: string }).method === 'POST')).toHaveLength(3);
  });

  it('uses a single token request for concurrent calls with equivalent credentials', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(okJson({ code: '0000', data: { accessToken: 'shared-token' } }))
      .mockResolvedValueOnce(okJson({ code: '0000', data: [], total: 0 }))
      .mockResolvedValueOnce(okJson({ code: '0000', data: [], total: 0 }));
    const client = new PhotonPayClient(fetchMock as never);

    await Promise.all([
      client.listCards({ credential: { appId: 'same-app', appSecret: 'same-secret' }, page: 1, pageSize: 20 }),
      client.listCards({ credential: { appId: 'same-app', appSecret: 'same-secret' }, page: 2, pageSize: 20 }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as { method?: string }).method === 'POST')).toHaveLength(1);
  });

  it('refreshes once after HTTP 401 and retries the business GET with the new token', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(okJson({ code: '0000', data: { accessToken: 'expired-token' } }))
      .mockResolvedValueOnce(httpJson(401, { code: '1002', message: 'invalid token' }))
      .mockResolvedValueOnce(okJson({ code: '0000', data: { accessToken: 'fresh-token' } }))
      .mockResolvedValueOnce(okJson({ code: '0000', data: [], total: 0 }));
    const client = new PhotonPayClient(fetchMock as never);

    await client.listCards({ credential: { appId: 'app-id', appSecret: 'app-secret' }, page: 1, pageSize: 20 });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers[PHOTONPAY_TOKEN_HEADER]).toBe('expired-token');
    expect((fetchMock.mock.calls[3][1] as { headers: Record<string, string> }).headers[PHOTONPAY_TOKEN_HEADER]).toBe('fresh-token');
  });

  it('refreshes once for official business code 1002 and stops after a second HTTP 401', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(okJson({ code: '0000', data: { accessToken: 'token-1' } }))
      .mockResolvedValueOnce(okJson({ code: '1002', message: 'invalid token' }))
      .mockResolvedValueOnce(okJson({ code: '0000', data: { accessToken: 'token-2' } }))
      .mockResolvedValueOnce(httpJson(401, { code: '1002', message: 'still invalid' }));
    const client = new PhotonPayClient(fetchMock as never);

    await expect(client.listCards({
      credential: { appId: 'app-id', appSecret: 'app-secret' },
      page: 1,
      pageSize: 20,
    })).rejects.toMatchObject({ httpStatus: 401, providerCode: '1002' });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as { method?: string }).method === 'POST')).toHaveLength(2);
  });

  it('does not refresh on HTTP 403 or retry a rejected token credential', async () => {
    const forbiddenFetch = jest.fn()
      .mockResolvedValueOnce(okJson({ code: '0000', data: { accessToken: 'token' } }))
      .mockResolvedValueOnce(httpJson(403, { code: '403', message: 'forbidden' }));
    const forbiddenClient = new PhotonPayClient(forbiddenFetch as never);
    await expect(forbiddenClient.listCards({
      credential: { appId: 'app-id', appSecret: 'app-secret' }, page: 1, pageSize: 20,
    })).rejects.toMatchObject({ httpStatus: 403 });
    expect(forbiddenFetch).toHaveBeenCalledTimes(2);

    const rejectedCredentialFetch = jest.fn().mockResolvedValueOnce(
      httpJson(401, { code: 'union-oauth2:21312', message: 'invalid client' }),
    );
    const rejectedCredentialClient = new PhotonPayClient(rejectedCredentialFetch as never);
    await expect(rejectedCredentialClient.listCards({
      credential: { appId: 'app-id', appSecret: 'app-secret' }, page: 1, pageSize: 20,
    })).rejects.toMatchObject({ httpStatus: 401, providerCode: 'union-oauth2:21312' });
    expect(rejectedCredentialFetch).toHaveBeenCalledTimes(1);
  });
});

describe('PhotonPayCardSyncAdapter', () => {
  let prisma: {
    cardBinding: { findFirst: jest.Mock };
    cardSpendEvent: { findUnique: jest.Mock; upsert: jest.Mock };
  };
  let client: { listCardTransactions: jest.Mock };
  let unmatchedEvents: { recordUnmatchedEvent: jest.Mock; resolveAfterSuccessfulImport: jest.Mock };
  let inventory: { syncProviderWithPayload: jest.Mock; resolveSpendOwner: jest.Mock; markTransactionSync: jest.Mock; markUntouchedTransactionSync: jest.Mock };
  let adapter: PhotonPayCardSyncAdapter;

  beforeEach(() => {
    prisma = {
      cardBinding: { findFirst: jest.fn() },
      cardSpendEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'spend-1' }),
      },
    };
    client = { listCardTransactions: jest.fn() };
    unmatchedEvents = {
      recordUnmatchedEvent: jest.fn().mockResolvedValue({ id: 'unmatched-1' }),
      resolveAfterSuccessfulImport: jest.fn().mockResolvedValue(false),
    };
    inventory = {
      syncProviderWithPayload: jest.fn().mockResolvedValue({ provider: Provider.photonpay, status: 'completed', discoveredCount: 1, matchedCount: 1, unmatchedCount: 0, conflictCount: 0, retainedHistoricalCards: true }),
      resolveSpendOwner: jest.fn().mockResolvedValue({ ok: true, employeeId }),
      markTransactionSync: jest.fn().mockResolvedValue(undefined),
      markUntouchedTransactionSync: jest.fn().mockResolvedValue(undefined),
    };
    adapter = new PhotonPayCardSyncAdapter(prisma as never, client as never, unmatchedEvents as never, inventory as never);
  });

  it('calculates requestWindow with the default 10 day settlement delay', () => {
    const window = getPhotonPayGmt8SettlementMonthWindow(settlementMonth);

    expect(window.settlementStartInclusiveUtc.toISOString()).toBe('2026-05-31T16:00:00.000Z');
    expect(window.settlementEndExclusiveUtc.toISOString()).toBe('2026-06-30T16:00:00.000Z');
    expect(window.requestFrom.toISOString()).toBe('2026-05-31T16:00:00.000Z');
    expect(window.requestTo.toISOString()).toBe('2026-07-10T16:00:00.000Z');
    expect(window.settlementDelayDays).toBe(10);
  });

  it('splits provider queries into continuous windows no longer than 30 days', () => {
    expect(splitPhotonPayQueryWindow(
      new Date('2026-05-31T16:00:00.000Z'),
      new Date('2026-07-10T16:00:00.000Z'),
    )).toEqual([
      { from: new Date('2026-05-31T16:00:00.000Z'), to: new Date('2026-06-30T16:00:00.000Z') },
      { from: new Date('2026-06-30T16:00:00.000Z'), to: new Date('2026-07-10T16:00:00.000Z') },
    ]);
  });

  it('accepts only the previous 1 or 7 complete Asia/Shanghai days for verification', () => {
    const now = new Date('2026-06-19T04:00:00.000Z');
    expect(parsePhotonPayVerificationWindow({
      from: '2026-06-17T16:00:00.000Z',
      to: '2026-06-18T16:00:00.000Z',
    }, settlementMonth, now).durationDays).toBe(1);
    expect(() => parsePhotonPayVerificationWindow({
      from: '2026-06-16T16:00:00.000Z',
      to: '2026-06-18T16:00:00.000Z',
    }, settlementMonth, now)).toThrow('exactly 1 or 7');
  });

  it('uses configured settlementDelayDays to extend requestWindow', async () => {
    mockTransactions([]);

    await adapter.execute(context({ settlementDelayDays: 3 }));

    expect(client.listCardTransactions).toHaveBeenNthCalledWith(1, expect.objectContaining({
      from: new Date('2026-05-31T16:00:00.000Z'),
      to: new Date('2026-06-30T16:00:00.000Z'),
      credential: expect.objectContaining({ settlementDelayDays: 3 }),
    }));
    expect(client.listCardTransactions).toHaveBeenNthCalledWith(2, expect.objectContaining({
      from: new Date('2026-06-30T16:00:00.000Z'),
      to: new Date('2026-07-03T16:00:00.000Z'),
      credential: expect.objectContaining({ settlementDelayDays: 3 }),
    }));
  });

  it('uses an explicitly validated one-day verification window without querying the full month', async () => {
    mockTransactions([]);
    const result = await adapter.execute(context({}, {
      verificationWindow: { from: '2026-06-17T16:00:00.000Z', to: '2026-06-18T16:00:00.000Z' },
    }));
    expect(client.listCardTransactions).toHaveBeenCalledTimes(1);
    expect(client.listCardTransactions).toHaveBeenCalledWith(expect.objectContaining({
      from: new Date('2026-06-17T16:00:00.000Z'),
      to: new Date('2026-06-18T16:00:00.000Z'),
    }));
    expect(result.resultPayload).toMatchObject({ verificationMode: true, settlementDelayDays: 0 });
  });

  it('falls back to the default settlementDelayDays when credential value is invalid', async () => {
    mockTransactions([]);

    const result = await adapter.execute(context({ settlementDelayDays: 99 }));

    expect(client.listCardTransactions).toHaveBeenCalledWith(expect.objectContaining({ to: new Date('2026-07-10T16:00:00.000Z') }));
    expect(result.resultPayload.settlementDelayDays).toBe(10);
  });

  it('upserts settled USD transactions as confirmed PhotonPay card spend events by card binding', async () => {
    mockTransactions([settledTransaction()]);
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
    expect(inventory.resolveSpendOwner).toHaveBeenCalledWith(Provider.photonpay, 'card-1', settlementMonth, new Date('2026-06-15T12:00:00.000Z'));
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
          sourceStatus: 'Settled|succeed|auth',
          sourceUpdatedAt: new Date('2026-07-02T00:00:00.000Z'),
          status: CommonStatus.confirmed,
          importedBy: actorUserId,
        }),
      }),
    );
    expect(prisma.cardSpendEvent.upsert.mock.calls[0][0].create.rawData).not.toHaveProperty('affiliateAccountId');
    expect(prisma.cardSpendEvent.upsert.mock.calls[0][0].create.rawData).not.toHaveProperty('subValue');
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('plain-api-key');
    expect(JSON.stringify(result)).not.toContain('plain-token');
    expect(JSON.stringify(result)).not.toContain('plain-secret');
  });

  it('ignores non-official localized settleStatus', async () => {
    mockTransactions([{ ...settledTransaction(), settleStatus: '已结算' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
  });

  it('ignores Unicode localized settleStatus', async () => {
    mockTransactions([{ ...settledTransaction(), settleStatus: '\u5df2\u7ed3\u7b97' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
  });

  it.each(['settled', 'SETTLED'])('accepts %s from settleStatus with succeed status', async (status) => {
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

    expect(result.status).toBe('completed');
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(inventory.resolveSpendOwner).not.toHaveBeenCalled();
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

    expect(result.status).toBe('completed');
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
  });

  it('writes an in-month transaction whose platform updated time is in the next month requestWindow', async () => {
    mockTransactions([{ ...settledTransaction(), txnDate: '2026-06-30T12:00:00.000Z', createdAt: '2026-07-02T00:00:00.000Z' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(prisma.cardSpendEvent.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.cardSpendEvent.upsert.mock.calls[0][0].create.transactionAt).toEqual(new Date('2026-06-30T12:00:00.000Z'));
  });

  it('does not write a next-month transaction even when requestWindow includes it', async () => {
    mockTransactions([{ ...settledTransaction(), txnDate: '2026-07-01T00:00:00.000Z', createdAt: '2026-07-02T00:00:00.000Z' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(inventory.resolveSpendOwner).not.toHaveBeenCalled();
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
  });

  it('rejects settled transactions with no active card binding', async () => {
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

  it('counts an excluded admin test card without creating spend or increasing failedCount', async () => {
    mockTransactions([settledTransaction()]);
    inventory.resolveSpendOwner.mockResolvedValue({
      ok: false,
      excluded: true,
      reasonCode: 'ADMIN_TEST_CARD',
      reasonMessage: 'excluded',
    });

    const result = await adapter.execute(context());

    expect(result).toMatchObject({ status: 'completed', successCount: 0, failedCount: 0 });
    expect(result.resultPayload).toMatchObject({ excludedCardTransactionCount: 1 });
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
    expect(inventory.markTransactionSync).toHaveBeenCalledWith(Provider.photonpay, 'card-1', 'excluded:admin_test_card');
  });

  it('rejects non-USD transactions without writing or converting FX', async () => {
    mockTransactions([{ ...settledTransaction(), transactionCurrency: 'HKD' }]);
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
    const { cardId: _cardId, ...transactionWithoutCardId } = settledTransaction();
    mockTransactions([transactionWithoutCardId]);

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.failedCount).toBe(1);
    expect(inventory.resolveSpendOwner).not.toHaveBeenCalled();
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

  it('skips an unchanged external transaction on the second identical sync', async () => {
    mockTransactions([settledTransaction()]);
    prisma.cardSpendEvent.findUnique.mockResolvedValue({
      cardId: 'card-1',
      employeeId,
      transactionAt: new Date('2026-06-15T12:00:00.000Z'),
      amount: new Prisma.Decimal('12.34'),
      currency: 'USD',
      spendUsd: new Prisma.Decimal('12.34'),
      settledAt: new Date('2026-06-20T00:00:00.000Z'),
      sourceStatus: 'Settled|succeed|auth',
      sourceUpdatedAt: new Date('2026-07-02T00:00:00.000Z'),
      status: CommonStatus.confirmed,
    });
    const result = await adapter.execute(context());
    expect(result.resultPayload).toMatchObject({ createdCount: 0, updatedCount: 0, skippedCount: 1 });
    expect(prisma.cardSpendEvent.upsert).not.toHaveBeenCalled();
  });

  it('treats zone-less PhotonPay transaction timestamps as UTC before GMT+8 month assignment', () => {
    const record = normalizePhotonPayTransaction({
      ...settledTransaction(),
      txnDate: '2026-06-30T15:59:59',
      createdAt: '2026-06-30T15:59:59',
    });
    expect(record.transactionAt).toEqual(new Date('2026-06-30T15:59:59.000Z'));
    expect(record.sourceUpdatedAt).toEqual(new Date('2026-06-30T15:59:59.000Z'));
  });

  it('redacts plaintext credentials from resultPayload, message, and errorMessage', async () => {
    client.listCardTransactions.mockRejectedValue(
      new Error('PhotonPay failed with plain-app-id plain-app-secret in upstream response.'),
    );

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('plain-app-id');
    expect(JSON.stringify(result)).not.toContain('plain-app-secret');
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
    transactionId: 'txn-1',
    cardId: 'card-1',
    settleStatus: 'Settled',
    status: 'succeed',
    transactionType: 'auth',
    txnDate: '2026-06-15T12:00:00.000Z',
    transactionAmount: '12.34',
    transactionCurrency: 'USD',
    settlementDate: '2026-06-20T00:00:00.000Z',
    createdAt: '2026-07-02T00:00:00.000Z',
  };
}

function context(payloadOverrides: Record<string, unknown> = {}, requestPayload?: Record<string, unknown>) {
  return {
    taskId: '20000000-0000-0000-0000-000000000001',
    sourceType: SyncTaskSourceType.card_spend,
    taskType: SyncTaskType.photonpay_card,
    platform: SyncTaskPlatform.photonpay,
    provider: Provider.photonpay,
    settlementMonth,
    requestedBy: actorUserId,
    requestPayload,
    credential: {
      credentialId: 'cred-1',
      hasCredential: true as const,
      maskedPayload: { apiKey: 'plain****-key' },
      payload: {
        appId: 'plain-app-id',
        appSecret: 'plain-app-secret',
        ...payloadOverrides,
      },
    },
  };
}

function okJson(body: unknown) {
  return { ok: true, json: jest.fn().mockResolvedValue(body) };
}

function httpJson(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
