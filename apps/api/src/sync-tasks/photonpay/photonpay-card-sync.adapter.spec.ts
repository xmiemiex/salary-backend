import {
  CommonStatus,
  Prisma,
  Provider,
  ProviderCardMatchSource,
  ProviderCardMatchStatus,
  SyncExecutionErrorCategory,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskType,
} from '@prisma/client';
import { SyncAdapterResolver } from '../sync-adapter-resolver';
import {
  PhotonPayCardSyncAdapter,
  getPhotonPayGmt8SettlementMonthWindow,
  normalizePhotonPayTransaction,
  parsePhotonPayHistoricalBackfillWindow,
  parsePhotonPayVerificationWindow,
  splitPhotonPayQueryWindow,
} from './photonpay-card-sync.adapter';
import {
  PHOTONPAY_DEFAULT_BASE_URL,
  PHOTONPAY_DEFAULT_TOKEN_PATH,
  PHOTONPAY_DEFAULT_TRANSACTIONS_PATH,
  PHOTONPAY_TOKEN_HEADER,
  PhotonPayClient,
  parsePhotonPayJsonPreservingUsdDebit,
} from './photonpay-client';

const actorUserId = '00000000-0000-0000-0000-000000000001';
const employeeId = '30000000-0000-0000-0000-000000000001';
const settlementMonth = new Date(Date.UTC(2026, 5, 1));

describe('PhotonPayClient', () => {
  it('preserves provider USD debit JSON number lexemes as strings without touching unrelated numbers or text', () => {
    const parsed = parsePhotonPayJsonPreservingUsdDebit(
      '{"code":"0000","data":[{"txnPrincipalChangeSettledAmount":-12.340000,"other":1.25,"note":"\\\"txnPrincipalChangeSettledAmount\\\":99"},{"txn_principal_change_settled_amount":-9.74}]}'
    ) as { data: Array<Record<string, unknown>> };

    expect(parsed.data[0].txnPrincipalChangeSettledAmount).toBe('-12.340000');
    expect(parsed.data[0].other).toBe(1.25);
    expect(parsed.data[0].note).toBe('"txnPrincipalChangeSettledAmount":99');
    expect(parsed.data[1].txn_principal_change_settled_amount).toBe('-9.74');
  });

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
    providerCard: { findMany: jest.Mock };
    cardSpendEvent: { findUnique: jest.Mock; create: jest.Mock };
  };
  let client: { listCardTransactions: jest.Mock };
  let unmatchedEvents: { recordUnmatchedEvent: jest.Mock; resolveAfterSuccessfulImport: jest.Mock };
  let inventory: { syncProviderWithPayload: jest.Mock; resolveSpendOwner: jest.Mock; markTransactionSync: jest.Mock; markUntouchedTransactionSync: jest.Mock };
  let adapter: PhotonPayCardSyncAdapter;

  beforeEach(() => {
    prisma = {
      cardBinding: { findFirst: jest.fn() },
      providerCard: { findMany: jest.fn().mockResolvedValue([]) },
      cardSpendEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'spend-1' }),
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

  it('splits provider queries into continuous windows no longer than 7 days', () => {
    const windows = splitPhotonPayQueryWindow(
      new Date('2026-05-31T16:00:00.000Z'),
      new Date('2026-07-10T16:00:00.000Z'),
    );
    expect(windows[0].from).toEqual(new Date('2026-05-31T16:00:00.000Z'));
    expect(windows.at(-1)?.to).toEqual(new Date('2026-07-10T16:00:00.000Z'));
    expect(windows.every(({ from, to }) => to.getTime() - from.getTime() <= 7 * 24 * 60 * 60 * 1_000)).toBe(true);
    expect(windows.slice(1).every((window, index) => window.from.getTime() === windows[index].to.getTime())).toBe(true);
  });

  it('validates bounded historical alias-card backfill windows and rejects pre-July access', () => {
    const now = new Date('2026-08-22T04:00:00.000Z');
    expect(parsePhotonPayHistoricalBackfillWindow({
      from: '2026-06-30T16:00:00.000Z',
      to: '2026-07-07T16:00:00.000Z',
      previewOnly: true,
    }, new Date(Date.UTC(2026, 6, 1)), now)).toMatchObject({ durationDays: 7, previewOnly: true });
    expect(() => parsePhotonPayHistoricalBackfillWindow({
      from: '2026-06-29T16:00:00.000Z',
      to: '2026-06-30T16:00:00.000Z',
      previewOnly: false,
    }, new Date(Date.UTC(2026, 5, 1)), now)).toThrow('before 2026-07-01');
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
      to: new Date('2026-06-07T16:00:00.000Z'),
      credential: expect.objectContaining({ settlementDelayDays: 3 }),
    }));
    expect(client.listCardTransactions).toHaveBeenLastCalledWith(expect.objectContaining({
      from: new Date('2026-06-28T16:00:00.000Z'),
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

  it('creates settled USD transactions with the provider USD debit as confirmed card spend', async () => {
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
    expect(prisma.cardSpendEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
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
    expect(prisma.cardSpendEvent.create.mock.calls[0][0].data.rawData).not.toHaveProperty('affiliateAccountId');
    expect(prisma.cardSpendEvent.create.mock.calls[0][0].data.rawData).not.toHaveProperty('subValue');
    expect(prisma.cardSpendEvent.create.mock.calls[0][0].data.rawData).not.toHaveProperty('transactionId');
    expect(prisma.cardSpendEvent.create.mock.calls[0][0].data.rawData).not.toHaveProperty('cardId');
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
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
  });

  it('ignores Unicode localized settleStatus', async () => {
    mockTransactions([{ ...settledTransaction(), settleStatus: '\u5df2\u7ed3\u7b97' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
  });

  it.each(['settled', 'SETTLED'])('accepts %s from settleStatus with succeed status', async (status) => {
    mockTransactions([{ ...settledTransaction(), settleStatus: status }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(prisma.cardSpendEvent.create).toHaveBeenCalledTimes(1);
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
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
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
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
  });

  it('writes an in-month transaction whose platform updated time is in the next month requestWindow', async () => {
    mockTransactions([{ ...settledTransaction(), txnDate: '2026-06-30T12:00:00.000Z', createdAt: '2026-07-02T00:00:00.000Z' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(prisma.cardSpendEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.cardSpendEvent.create.mock.calls[0][0].data.transactionAt).toEqual(new Date('2026-06-30T12:00:00.000Z'));
  });

  it('does not write a next-month transaction even when requestWindow includes it', async () => {
    mockTransactions([{ ...settledTransaction(), txnDate: '2026-07-01T00:00:00.000Z', createdAt: '2026-07-02T00:00:00.000Z' }]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    const result = await adapter.execute(context());

    expect(result.status).toBe('completed');
    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(inventory.resolveSpendOwner).not.toHaveBeenCalled();
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
  });

  it('rejects settled transactions with no active card binding', async () => {
    mockTransactions([settledTransaction()]);
    inventory.resolveSpendOwner.mockResolvedValue({ ok: false, reasonCode: 'CARD_NOT_MAPPED', reasonMessage: 'not mapped' });

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.failedCount).toBe(1);
    expect(result.resultPayload).toMatchObject({
      ownershipFailureCount: 1,
      ownershipFailureCountByReason: { CARD_NOT_MAPPED: 1 },
    });
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
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
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
    expect(inventory.markTransactionSync).toHaveBeenCalledWith(Provider.photonpay, 'card-1', 'excluded:admin_test_card');
  });

  it('imports non-USD settled spend with PhotonPay actual USD debit without internal FX', async () => {
    mockTransactions([{
      ...settledTransaction(),
      transactionAmount: '100.00',
      transactionCurrency: 'HKD',
      txnPrincipalChangeSettledAmount: '-12.34',
    }]);

    const result = await adapter.execute(context());

    expect(result).toMatchObject({ status: 'completed', successCount: 1, failedCount: 0 });
    expect(result.resultPayload).toMatchObject({
      settledConvertedToUsdCount: 1,
      settledUsdTransactionCount: 0,
      providerUsdDebitAmountTotal: '12.34',
    });
    expect(prisma.cardSpendEvent.create.mock.calls[0][0].data).toMatchObject({
      amount: new Prisma.Decimal('100'),
      currency: 'HKD',
      spendUsd: new Prisma.Decimal('12.34'),
    });
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['EUR', '8.25', '-9.74'],
    ['JPY', '21617', '-136.74'],
    ['VND', '312879', '-8.92'],
  ])('uses PhotonPay actual USD debit for %s settled spend', async (currency, originalAmount, usdDebit) => {
    mockTransactions([{
      ...settledTransaction(),
      transactionCurrency: currency,
      transactionAmount: originalAmount,
      txnPrincipalChangeSettledAmount: usdDebit,
    }]);

    const result = await adapter.execute(context());

    expect(result).toMatchObject({ status: 'completed', successCount: 1, failedCount: 0 });
    expect(prisma.cardSpendEvent.create.mock.calls[0][0].data).toMatchObject({
      amount: new Prisma.Decimal(originalAmount),
      currency,
      spendUsd: new Prisma.Decimal(usdDebit).abs(),
    });
  });

  it.each([
    ['missing', undefined, 'USD', 'missingProviderUsdDebitAmountCount'],
    ['numeric JSON value', -12.34, 'USD', 'invalidProviderUsdDebitAmountCount'],
    ['zero', '0.00', 'USD', 'invalidProviderUsdDebitAmountCount'],
    ['positive account change', '12.34', 'USD', 'invalidProviderUsdDebitAmountCount'],
    ['over-precision', '-12.3456789', 'USD', 'invalidProviderUsdDebitAmountCount'],
    ['non-USD debit account', '-12.34', 'EUR', 'invalidProviderUsdDebitAmountCount'],
  ])('fails closed for %s provider USD debit without writing', async (_label, providerAmount, providerCurrency, statName) => {
    const transaction = {
      ...settledTransaction(),
      txnPrincipalChangeSettledAmount: providerAmount,
      txnPrincipalChangeCurrency: providerCurrency,
    };
    mockTransactions([transaction]);

    const result = await adapter.execute(context());

    expect(result).toMatchObject({ status: 'failed', successCount: 0, failedCount: 1 });
    expect(result.resultPayload).toMatchObject({ [statName]: 1, providerUsdDebitAmountTotal: '0' });
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: statName === 'missingProviderUsdDebitAmountCount'
        ? 'PROVIDER_USD_DEBIT_AMOUNT_MISSING'
        : 'PROVIDER_USD_DEBIT_AMOUNT_INVALID',
    }));
  });

  it.each(['refund', 'corrective_refund', 'refund_reversal', 'corrective_refund_void', 'void']) (
    'does not import settled non-spend type %s as positive consumption',
    async (transactionType) => {
      mockTransactions([{ ...settledTransaction(), transactionType }]);

      const result = await adapter.execute(context());

      expect(result).toMatchObject({ status: 'completed', successCount: 0, failedCount: 0 });
      expect(result.resultPayload).toMatchObject({ nonSpendSettledTransactionCount: 1 });
      expect(inventory.resolveSpendOwner).not.toHaveBeenCalled();
      expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
    },
  );

  it('fails closed when an existing external transaction has different financial values', async () => {
    mockTransactions([settledTransaction()]);
    prisma.cardSpendEvent.findUnique.mockResolvedValue({
      cardId: 'card-1',
      employeeId,
      transactionAt: new Date('2026-06-15T12:00:00.000Z'),
      amount: new Prisma.Decimal('12.34'),
      currency: 'USD',
      spendUsd: new Prisma.Decimal('99.99'),
      settledAt: new Date('2026-06-20T00:00:00.000Z'),
      sourceStatus: 'Settled|succeed|auth',
      sourceUpdatedAt: new Date('2026-07-02T00:00:00.000Z'),
      status: CommonStatus.confirmed,
    });

    const result = await adapter.execute(context());

    expect(result).toMatchObject({ status: 'failed', successCount: 0, failedCount: 1 });
    expect(result.resultPayload).toMatchObject({ amountMismatchCount: 1, createdCount: 0, updatedCount: 0 });
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'PROVIDER_USD_DEBIT_AMOUNT_MISMATCH',
    }));
  });

  it('records settled transactions missing cardId as unmatched', async () => {
    const { cardId: _cardId, ...transactionWithoutCardId } = settledTransaction();
    mockTransactions([transactionWithoutCardId]);

    const result = await adapter.execute(context());

    expect(result.status).toBe('failed');
    expect(result.failedCount).toBe(1);
    expect(result.resultPayload).toMatchObject({ missingCardIdCount: 1 });
    expect(inventory.resolveSpendOwner).not.toHaveBeenCalled();
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
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

  it('counts a missing external transaction id and fails closed without a financial write', async () => {
    const { transactionId: _transactionId, ...transactionWithoutId } = settledTransaction();
    mockTransactions([transactionWithoutId]);

    const result = await adapter.execute(context());

    expect(result).toMatchObject({ status: 'failed', successCount: 0, failedCount: 1 });
    expect(result.resultPayload).toMatchObject({ missingExternalEventIdCount: 1 });
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'EXTERNAL_EVENT_ID_MISSING',
    }));
  });

  it('uses provider + externalEventId as the immutable create identity', async () => {
    mockTransactions([settledTransaction()]);
    prisma.cardBinding.findFirst.mockResolvedValue({ employeeId });

    await adapter.execute(context());

    expect(prisma.cardSpendEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.cardSpendEvent.create.mock.calls[0][0].data).toMatchObject({
      provider: Provider.photonpay,
      externalEventId: 'txn-1',
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
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
  });

  it('reproduces the task100 158/147/67 window with exact Decimal USD debit totals', async () => {
    const makeTransactions = (
      count: number,
      currency: string,
      originalAmounts: string[],
      providerAmounts: string[],
      offset: number,
    ) => Array.from({ length: count }, (_, index) => ({
      ...settledTransaction(),
      transactionId: `txn-${offset + index}`,
      cardId: `card-${offset + index}`,
      txnDate: '2026-08-19T12:00:00.000Z',
      transactionCurrency: currency,
      transactionAmount: originalAmounts[index],
      txnPrincipalChangeSettledAmount: providerAmounts[index],
    }));
    const settled = [
      ...makeTransactions(80, 'USD', [...Array(79).fill('5'), '9.53'], [...Array(79).fill('-5'), '-9.53'], 0),
      ...makeTransactions(47, 'EUR', [...Array(46).fill('3'), '16.38'], [...Array(46).fill('-3'), '-41.62'], 80),
      ...makeTransactions(2, 'JPY', ['21616', '21617'], ['-136.74', '-136.74'], 127),
      ...makeTransactions(18, 'VND', [...Array(17).fill('100000'), '312879'], [...Array(17).fill('-4'), '-8.92'], 129),
    ];
    const nonSettled = Array.from({ length: 11 }, (_, index) => ({
      ...settledTransaction(),
      transactionId: `nonsettled-${index}`,
      cardId: `nonsettled-card-${index}`,
      txnDate: '2026-08-19T12:00:00.000Z',
      settleStatus: index < 3 ? 'pending' : 'not_settle',
    }));
    mockTransactions([...settled, ...nonSettled]);
    const task100Context = {
      ...context(),
      settlementMonth: new Date(Date.UTC(2026, 7, 1)),
      requestPayload: {
        verificationWindow: { from: '2026-08-18T16:00:00.000Z', to: '2026-08-19T16:00:00.000Z' },
      },
    };

    const result = await adapter.execute(task100Context);

    expect(result).toMatchObject({ status: 'completed', successCount: 147, failedCount: 0 });
    expect(result.resultPayload).toMatchObject({
      providerTransactionCount: 158,
      settledTransactionCount: 147,
      targetSettledTransactionCount: 147,
      nonSettledTransactionCount: 11,
      settledUsdTransactionCount: 80,
      settledConvertedToUsdCount: 67,
      providerUsdDebitAmountTotal: '934.55',
      missingProviderUsdDebitAmountCount: 0,
      invalidProviderUsdDebitAmountCount: 0,
      settledTransactionCountByCurrency: { USD: 80, EUR: 47, JPY: 2, VND: 18 },
      targetSettledTransactionCountByCurrency: { USD: 80, EUR: 47, JPY: 2, VND: 18 },
      settledAmountByCurrency: {
        USD: '404.53',
        EUR: '154.38',
        JPY: '43233',
        VND: '2012879',
      },
    });
    expect(prisma.cardSpendEvent.create).toHaveBeenCalledTimes(147);
  });

  it('previews only the exact 60 alias-matched historical cards and counts admin exclusion without writes', async () => {
    prisma.providerCard.findMany.mockResolvedValue([
      ...Array.from({ length: 60 }, (_, index) => ({
        cardId: `alias-${index + 1}`,
        matchStatus: ProviderCardMatchStatus.matched,
        matchSource: ProviderCardMatchSource.provider_email_alias,
      })),
      {
        cardId: 'admin-test-card',
        matchStatus: ProviderCardMatchStatus.excluded,
        matchSource: null,
      },
    ]);
    mockTransactions([
      { ...settledTransaction(), transactionId: 'target-txn', cardId: 'alias-1', txnDate: '2026-07-02T00:00:00.000Z' },
      { ...settledTransaction(), transactionId: 'primary-txn', cardId: 'primary-card', txnDate: '2026-07-02T00:00:00.000Z' },
      { ...settledTransaction(), transactionId: 'excluded-txn', cardId: 'admin-test-card', txnDate: '2026-07-02T00:00:00.000Z' },
    ]);
    const historicalContext = {
      ...context(),
      settlementMonth: new Date(Date.UTC(2026, 6, 1)),
      requestPayload: {
        historicalBackfill: {
          from: '2026-06-30T16:00:00.000Z',
          to: '2026-07-02T16:00:00.000Z',
          previewOnly: true,
        },
      },
    };

    const result = await adapter.execute(historicalContext);

    expect(result).toMatchObject({ status: 'completed', successCount: 1, failedCount: 0 });
    expect(result.resultPayload).toMatchObject({
      historicalBackfillMode: true,
      previewOnly: true,
      expectedTargetCardCount: 60,
      targetCardCount: 60,
      targetSettledTransactionCount: 1,
      targetSettledTransactionCountByCurrency: { USD: 1 },
      previewExpectedCreatedCount: 1,
      excludedCardTransactionCount: 1,
      nonTargetCardTransactionCount: 1,
      providerUsdDebitAmountTotal: '12.34',
    });
    expect(inventory.syncProviderWithPayload).not.toHaveBeenCalled();
    expect(inventory.resolveSpendOwner).toHaveBeenCalledTimes(1);
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
    expect(unmatchedEvents.recordUnmatchedEvent).not.toHaveBeenCalled();
    expect(inventory.markTransactionSync).not.toHaveBeenCalled();
    expect(inventory.markUntouchedTransactionSync).not.toHaveBeenCalled();
  });

  it('stops historical backfill before provider queries when the alias target set is not exactly 60', async () => {
    prisma.providerCard.findMany.mockResolvedValue(Array.from({ length: 59 }, (_, index) => ({
      cardId: `alias-${index + 1}`,
      matchStatus: ProviderCardMatchStatus.matched,
      matchSource: ProviderCardMatchSource.provider_email_alias,
    })));
    const historicalContext = {
      ...context(),
      settlementMonth: new Date(Date.UTC(2026, 6, 1)),
      requestPayload: {
        historicalBackfill: {
          from: '2026-06-30T16:00:00.000Z',
          to: '2026-07-01T16:00:00.000Z',
          previewOnly: false,
        },
      },
    };

    const result = await adapter.execute(historicalContext);

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('exactly 60');
    expect(client.listCardTransactions).not.toHaveBeenCalled();
    expect(prisma.cardSpendEvent.create).not.toHaveBeenCalled();
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
    txnPrincipalChangeSettledAmount: '-12.34',
    txnPrincipalChangeCurrency: 'USD',
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
