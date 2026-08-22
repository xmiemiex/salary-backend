import { Inject, Injectable, Optional } from '@nestjs/common';
import { SyncExecutionErrorCategory } from '@prisma/client';
import { createHash } from 'node:crypto';
import { ProviderRequestError, providerFetch } from '../provider-request-error';

export const PHOTONPAY_DEFAULT_BASE_URL = 'https://x-api.photonpay.com';
export const PHOTONPAY_DEFAULT_TOKEN_PATH = '/oauth2/token/accessToken';
export const PHOTONPAY_DEFAULT_CARDS_PATH = '/vcc/openApi/v4/pagingVccCard';
export const PHOTONPAY_DEFAULT_CARD_DETAIL_PATH = '/vcc/openApi/v4/getCardDetail';
export const PHOTONPAY_DEFAULT_TRANSACTIONS_PATH = '/vcc/openApi/v4/pagingVccTradeOrder';
export const PHOTONPAY_FETCH = 'PHOTONPAY_FETCH';
export const PHOTONPAY_TOKEN_HEADER = 'X-PD-TOKEN';

export type PhotonPayCredentialPayload = {
  baseUrl?: string;
  tokenPath?: string;
  cardsPath?: string;
  cardDetailPath?: string;
  transactionsPath?: string;
  appId: string;
  appSecret: string;
  settlementDelayDays?: number;
};

export type PhotonPayTransactionRecord = Record<string, unknown>;
export type PhotonPayCardRecord = {
  cardId: string | null;
  cardholderId: string | null;
  email: string | null;
  maskCardNo: string | null;
  nickname: string | null;
  cardStatus: string | null;
  cardOrganization: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
export type PhotonPayTransactionsResponse = { transactions: PhotonPayTransactionRecord[]; hasMore: boolean };
export type PhotonPayCardsResponse = { cards: PhotonPayCardRecord[]; hasMore: boolean };
export type PhotonPaySafeDiagnostics = {
  authenticationRequestCount: number;
  authenticationCacheHitCount: number;
  authenticationRefreshCount: number;
  cardListRequestCount: number;
  cardDetailRequestCount: number;
  transactionListRequestCount: number;
  lastAuth: {
    httpStatus: number | null;
    providerCode: string | null;
    providerMessage: string | null;
    requestId: string | null;
    accessGranted: boolean;
    elapsedMs: number;
  } | null;
};

type FetchLike = typeof fetch;

@Injectable()
export class PhotonPayClient {
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();
  private readonly tokenRequests = new Map<string, Promise<string>>();
  private readonly safeDiagnostics: PhotonPaySafeDiagnostics = {
    authenticationRequestCount: 0,
    authenticationCacheHitCount: 0,
    authenticationRefreshCount: 0,
    cardListRequestCount: 0,
    cardDetailRequestCount: 0,
    transactionListRequestCount: 0,
    lastAuth: null,
  };

  constructor(@Optional() @Inject(PHOTONPAY_FETCH) private readonly fetchImpl: FetchLike = fetch) {}

  async listCards(input: { credential: PhotonPayCredentialPayload; page: number; pageSize: number }): Promise<PhotonPayCardsResponse> {
    this.safeDiagnostics.cardListRequestCount += 1;
    const raw = await this.authorizedGet(input.credential, input.credential.cardsPath ?? PHOTONPAY_DEFAULT_CARDS_PATH, {
      pageIndex: input.page, pageSize: input.pageSize,
    });
    const cards = extractDataArray(raw).map(toSafeCardListRecord);
    const total = extractTotal(raw);
    return { cards, hasMore: total === null ? cards.length >= input.pageSize : input.page * input.pageSize < total };
  }

  async getCardDetail(input: { credential: PhotonPayCredentialPayload; cardId: string }): Promise<PhotonPayCardRecord> {
    this.safeDiagnostics.cardDetailRequestCount += 1;
    const raw = await this.authorizedGet(input.credential, input.credential.cardDetailPath ?? PHOTONPAY_DEFAULT_CARD_DETAIL_PATH, {
      cardId: input.cardId,
    });
    // The official response can contain cardNo. Only this allowlisted projection leaves the client.
    return toSafeCardDetail(extractDataObject(raw), input.cardId);
  }

  async listCardTransactions(input: {
    credential: PhotonPayCredentialPayload; from: Date; to: Date; page: number; pageSize: number;
  }): Promise<PhotonPayTransactionsResponse> {
    this.safeDiagnostics.transactionListRequestCount += 1;
    const raw = await this.authorizedGet(input.credential, input.credential.transactionsPath ?? PHOTONPAY_DEFAULT_TRANSACTIONS_PATH, {
      // PhotonPay uses a zone-less LocalDateTime containing a UTC wall-clock
      // value. Sending GMT+8 text shifts the requested interval by eight hours.
      createdAtStart: formatUtcLocalDateTime(input.from),
      createdAtEnd: formatUtcLocalDateTime(input.to),
      pageIndex: input.page,
      pageSize: input.pageSize,
    });
    const transactions = extractDataArray(raw);
    const total = extractTotal(raw);
    return { transactions, hasMore: total === null ? transactions.length >= input.pageSize : input.page * input.pageSize < total };
  }

  getSafeDiagnostics(): PhotonPaySafeDiagnostics {
    return {
      ...this.safeDiagnostics,
      lastAuth: this.safeDiagnostics.lastAuth ? { ...this.safeDiagnostics.lastAuth } : null,
    };
  }

  private async authorizedGet(credential: PhotonPayCredentialPayload, path: string, query: Record<string, string | number>) {
    assertProductionSafeEndpoint(credential, path);
    const url = new URL(path, normalizeBaseUrl(credential.baseUrl));
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.accessToken(credential, attempt > 0);
      try {
        const response = await providerFetch(this.fetchImpl, 'PhotonPay', url, {
          method: 'GET', headers: { Accept: 'application/json', [PHOTONPAY_TOKEN_HEADER]: token },
        });
        const parsed = typeof response.text === 'function'
          ? parsePhotonPayJsonPreservingUsdDebit(await response.text())
          : await response.json();
        return assertBusinessSuccess(parsed, SyncExecutionErrorCategory.BUSINESS_REJECTED, [
          credential.appId, credential.appSecret, token,
        ]);
      } catch (error) {
        const sanitized = redactProviderRequestError(error, [credential.appId, credential.appSecret, token]);
        if (attempt === 0 && isInvalidAccessToken(sanitized)) {
          this.tokenCache.delete(tokenCacheKey(credential));
          continue;
        }
        throw sanitized;
      }
    }

    throw new ProviderRequestError(SyncExecutionErrorCategory.CREDENTIAL_INVALID, 'PhotonPay access token refresh failed.');
  }

  private async accessToken(credential: PhotonPayCredentialPayload, forceRefresh = false): Promise<string> {
    const cacheKey = tokenCacheKey(credential);
    if (!forceRefresh) {
      const cached = this.tokenCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        this.safeDiagnostics.authenticationCacheHitCount += 1;
        return cached.token;
      }
    } else {
      this.safeDiagnostics.authenticationRefreshCount += 1;
      this.tokenCache.delete(cacheKey);
    }

    const inFlight = this.tokenRequests.get(cacheKey);
    if (inFlight) return inFlight;

    const request = this.requestAccessToken(credential, cacheKey);
    this.tokenRequests.set(cacheKey, request);
    try {
      return await request;
    } finally {
      if (this.tokenRequests.get(cacheKey) === request) this.tokenRequests.delete(cacheKey);
    }
  }

  private async requestAccessToken(credential: PhotonPayCredentialPayload, cacheKey: string): Promise<string> {
    assertProductionSafeEndpoint(credential, credential.tokenPath ?? PHOTONPAY_DEFAULT_TOKEN_PATH);
    this.safeDiagnostics.authenticationRequestCount += 1;
    const startedAt = Date.now();
    const url = new URL(credential.tokenPath ?? PHOTONPAY_DEFAULT_TOKEN_PATH, normalizeBaseUrl(credential.baseUrl));
    const encodedCredential = Buffer.from(`${credential.appId}/${credential.appSecret}`, 'utf8').toString('base64');
    const authorization = `basic ${encodedCredential}`;
    try {
      const response = await providerFetch(this.fetchImpl, 'PhotonPay', url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: authorization,
        },
      });
      const rawJson = await readJsonResponse(response, SyncExecutionErrorCategory.CREDENTIAL_INVALID);
      const rawRecord = isRecord(rawJson) ? rawJson : {};
      const raw = assertBusinessSuccess(rawJson, SyncExecutionErrorCategory.CREDENTIAL_INVALID, [
        credential.appId, credential.appSecret, encodedCredential, authorization,
      ]);
      const data = extractDataObject(raw);
      const token = firstString(data.accessToken, data.access_token, data.token, raw.accessToken);
      this.safeDiagnostics.lastAuth = {
        httpStatus: typeof response.status === 'number' ? response.status : 200,
        providerCode: safeProviderCode(firstString(rawRecord.code), [credential.appId, credential.appSecret, encodedCredential, authorization]),
        providerMessage: redactSensitiveText(firstString(rawRecord.message, rawRecord.msg), [credential.appId, credential.appSecret, encodedCredential, authorization]),
        requestId: redactSensitiveText(firstString(rawRecord.requestId, rawRecord.request_id, rawRecord.traceId), [credential.appId, credential.appSecret, encodedCredential, authorization]),
        accessGranted: Boolean(token),
        elapsedMs: Math.max(0, Date.now() - startedAt),
      };
      if (!token) throw new ProviderRequestError(SyncExecutionErrorCategory.CREDENTIAL_INVALID, 'PhotonPay authentication response was invalid.');
      const expiresIn = Math.max(1, firstNumber(data.expiresIn, data.expires_in) ?? 7_200);
      const refreshLeadSeconds = Math.min(300, Math.max(60, Math.floor(expiresIn * 0.1)));
      const cacheLifetimeSeconds = Math.max(1, expiresIn - refreshLeadSeconds);
      this.tokenCache.set(cacheKey, { token, expiresAt: Date.now() + cacheLifetimeSeconds * 1_000 });
      return token;
    } catch (error) {
      const sanitized = redactProviderRequestError(error, [credential.appId, credential.appSecret, encodedCredential, authorization]);
      if (sanitized instanceof ProviderRequestError) {
        this.safeDiagnostics.lastAuth = {
          httpStatus: sanitized.httpStatus ?? null,
          providerCode: sanitized.providerCode ?? null,
          providerMessage: sanitized.providerMessage ?? null,
          requestId: sanitized.requestId ?? null,
          accessGranted: false,
          elapsedMs: Math.max(0, Date.now() - startedAt),
        };
      }
      throw sanitized;
    }
  }
}

const PHOTONPAY_USD_DEBIT_JSON_KEYS = new Set([
  'txnPrincipalChangeSettledAmount',
  'txn_principal_change_settled_amount',
]);

export function parsePhotonPayJsonPreservingUsdDebit(source: string): unknown {
  const output: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] !== '"') {
      output.push(source[cursor]);
      cursor += 1;
      continue;
    }

    const stringEnd = findJsonStringEnd(source, cursor);
    const stringToken = source.slice(cursor, stringEnd + 1);
    output.push(stringToken);
    const key = JSON.parse(stringToken) as unknown;
    let colon = skipJsonWhitespace(source, stringEnd + 1);
    if (typeof key !== 'string' || !PHOTONPAY_USD_DEBIT_JSON_KEYS.has(key) || source[colon] !== ':') {
      cursor = stringEnd + 1;
      continue;
    }

    colon += 1;
    const valueStart = skipJsonWhitespace(source, colon);
    const numberToken = readJsonNumber(source, valueStart);
    if (!numberToken) {
      cursor = stringEnd + 1;
      continue;
    }
    output.push(source.slice(stringEnd + 1, valueStart));
    output.push(JSON.stringify(numberToken));
    cursor = valueStart + numberToken.length;
  }
  return JSON.parse(output.join('')) as unknown;
}

function findJsonStringEnd(source: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') return index;
  }
  throw new SyntaxError('Unterminated JSON string.');
}

function skipJsonWhitespace(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  return cursor;
}

function readJsonNumber(source: string, start: number): string | null {
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(start));
  if (!match) return null;
  const end = start + match[0].length;
  const delimiter = source[skipJsonWhitespace(source, end)];
  return delimiter === ',' || delimiter === '}' || delimiter === ']' ? match[0] : null;
}

function tokenCacheKey(credential: PhotonPayCredentialPayload): string {
  return createHash('sha256')
    .update(normalizeBaseUrl(credential.baseUrl), 'utf8')
    .update('\0')
    .update(credential.tokenPath ?? PHOTONPAY_DEFAULT_TOKEN_PATH, 'utf8')
    .update('\0')
    .update(credential.appId, 'utf8')
    .update('\0')
    .update(credential.appSecret, 'utf8')
    .digest('hex');
}

function isInvalidAccessToken(error: unknown): boolean {
  return error instanceof ProviderRequestError
    && (error.httpStatus === 401 || error.providerCode === '1002');
}

function assertBusinessSuccess(
  raw: unknown,
  category: SyncExecutionErrorCategory = SyncExecutionErrorCategory.BUSINESS_REJECTED,
  sensitiveValues: string[] = [],
): Record<string, unknown> {
  if (!isRecord(raw)) throw new ProviderRequestError(category, 'PhotonPay response was invalid.');
  const rawCode = firstString(raw.code);
  if (rawCode && rawCode !== '0000') {
    const code = redactSensitiveText(rawCode, sensitiveValues);
    const providerMessage = redactSensitiveText(firstString(raw.message, raw.msg), sensitiveValues);
    const requestId = redactSensitiveText(firstString(raw.requestId, raw.request_id, raw.traceId), sensitiveValues);
    throw new ProviderRequestError(
      category,
      `PhotonPay rejected the request. ${code}${providerMessage ? `: ${providerMessage}` : ''}`,
      200, code ?? undefined, providerMessage ?? undefined, requestId ?? undefined,
    );
  }
  return raw;
}

function safeProviderCode(value: string | null, sensitiveValues: string[]): string | null {
  return value === '0000' ? value : redactSensitiveText(value, sensitiveValues);
}

async function readJsonResponse(response: Response, category: SyncExecutionErrorCategory): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderRequestError(category, 'PhotonPay response was not valid JSON.', response.status);
  }
}

function redactProviderRequestError(error: unknown, sensitiveValues: string[]): unknown {
  if (!(error instanceof ProviderRequestError)) return error;
  return new ProviderRequestError(
    error.category,
    redactSensitiveText(error.message, sensitiveValues) ?? 'PhotonPay request failed.',
    error.httpStatus,
    redactSensitiveText(error.providerCode, sensitiveValues) ?? undefined,
    redactSensitiveText(error.providerMessage, sensitiveValues) ?? undefined,
    redactSensitiveText(error.requestId, sensitiveValues) ?? undefined,
    error.apiVersion,
  );
}

function redactSensitiveText(value: string | null | undefined, sensitiveValues: string[]): string | null {
  if (!value) return null;
  return sensitiveValues
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((sanitized, sensitive) => sanitized.split(sensitive).join('[REDACTED]'), value);
}

function extractDataArray(raw: Record<string, unknown>): PhotonPayTransactionRecord[] {
  const data = raw.data;
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return [];
  for (const candidate of [data.data, data.list, data.records, data.items]) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function extractDataObject(raw: Record<string, unknown>): Record<string, unknown> {
  return isRecord(raw.data) ? raw.data : raw;
}

function extractTotal(raw: Record<string, unknown>): number | null {
  const data = isRecord(raw.data) ? raw.data : undefined;
  return firstNumber(raw.total, raw.totalCount, data?.total, data?.totalCount);
}

function toSafeCardListRecord(record: Record<string, unknown>): PhotonPayCardRecord {
  return toSafeCardDetail(record, firstString(record.cardId) ?? '');
}

function toSafeCardDetail(record: Record<string, unknown>, fallbackCardId: string): PhotonPayCardRecord {
  const cardId = firstString(record.cardId) ?? fallbackCardId;
  return {
    cardId: cardId || null,
    cardholderId: firstString(record.cardholderId, record.memberId),
    email: firstString(record.email),
    maskCardNo: maskOnly(firstString(record.maskCardNo)),
    nickname: firstString(record.nickname),
    cardStatus: firstString(record.cardStatus),
    cardOrganization: firstString(record.cardOrganization, record.cardOrg, record.cardBrand, record.cardNetwork),
    createdAt: firstString(record.createdAt),
    updatedAt: firstString(record.updatedAt),
  };
}

function maskOnly(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `****${digits.slice(-4)}` : null;
}

function formatUtcLocalDateTime(date: Date): string {
  return date.toISOString().slice(0, 19);
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? PHOTONPAY_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function assertProductionSafeEndpoint(credential: PhotonPayCredentialPayload, path: string) {
  if (process.env.NODE_ENV !== 'production') return;
  if (normalizeBaseUrl(credential.baseUrl) !== PHOTONPAY_DEFAULT_BASE_URL) {
    throw new ProviderRequestError(SyncExecutionErrorCategory.INVALID_CONFIGURATION, 'PhotonPay production requires the official production API host.');
  }
  const allowedPaths = new Set([
    credential.tokenPath ?? PHOTONPAY_DEFAULT_TOKEN_PATH,
    credential.cardsPath ?? PHOTONPAY_DEFAULT_CARDS_PATH,
    credential.cardDetailPath ?? PHOTONPAY_DEFAULT_CARD_DETAIL_PATH,
    credential.transactionsPath ?? PHOTONPAY_DEFAULT_TRANSACTIONS_PATH,
  ]);
  const requiredDefaults = new Set([
    PHOTONPAY_DEFAULT_TOKEN_PATH,
    PHOTONPAY_DEFAULT_CARDS_PATH,
    PHOTONPAY_DEFAULT_CARD_DETAIL_PATH,
    PHOTONPAY_DEFAULT_TRANSACTIONS_PATH,
  ]);
  if (!allowedPaths.has(path) || !requiredDefaults.has(path)) {
    throw new ProviderRequestError(SyncExecutionErrorCategory.INVALID_CONFIGURATION, 'PhotonPay production endpoint is not allowlisted.');
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
