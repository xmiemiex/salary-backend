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
  createdAt: string | null;
  updatedAt: string | null;
};
export type PhotonPayTransactionsResponse = { transactions: PhotonPayTransactionRecord[]; hasMore: boolean };
export type PhotonPayCardsResponse = { cards: PhotonPayCardRecord[]; hasMore: boolean };

type FetchLike = typeof fetch;

@Injectable()
export class PhotonPayClient {
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();
  private readonly tokenRequests = new Map<string, Promise<string>>();

  constructor(@Optional() @Inject(PHOTONPAY_FETCH) private readonly fetchImpl: FetchLike = fetch) {}

  async listCards(input: { credential: PhotonPayCredentialPayload; page: number; pageSize: number }): Promise<PhotonPayCardsResponse> {
    const raw = await this.authorizedGet(input.credential, input.credential.cardsPath ?? PHOTONPAY_DEFAULT_CARDS_PATH, {
      pageIndex: input.page, pageSize: input.pageSize,
    });
    const cards = extractDataArray(raw).map(toSafeCardListRecord);
    const total = extractTotal(raw);
    return { cards, hasMore: total === null ? cards.length >= input.pageSize : input.page * input.pageSize < total };
  }

  async getCardDetail(input: { credential: PhotonPayCredentialPayload; cardId: string }): Promise<PhotonPayCardRecord> {
    const raw = await this.authorizedGet(input.credential, input.credential.cardDetailPath ?? PHOTONPAY_DEFAULT_CARD_DETAIL_PATH, {
      cardId: input.cardId,
    });
    // The official response can contain cardNo. Only this allowlisted projection leaves the client.
    return toSafeCardDetail(extractDataObject(raw), input.cardId);
  }

  async listCardTransactions(input: {
    credential: PhotonPayCredentialPayload; from: Date; to: Date; page: number; pageSize: number;
  }): Promise<PhotonPayTransactionsResponse> {
    const raw = await this.authorizedGet(input.credential, input.credential.transactionsPath ?? PHOTONPAY_DEFAULT_TRANSACTIONS_PATH, {
      createdAtStart: formatGmt8DateTime(input.from),
      createdAtEnd: formatGmt8DateTime(input.to),
      pageIndex: input.page,
      pageSize: input.pageSize,
    });
    const transactions = extractDataArray(raw);
    const total = extractTotal(raw);
    return { transactions, hasMore: total === null ? transactions.length >= input.pageSize : input.page * input.pageSize < total };
  }

  private async authorizedGet(credential: PhotonPayCredentialPayload, path: string, query: Record<string, string | number>) {
    const url = new URL(path, normalizeBaseUrl(credential.baseUrl));
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.accessToken(credential, attempt > 0);
      try {
        const response = await providerFetch(this.fetchImpl, 'PhotonPay', url, {
          method: 'GET', headers: { Accept: 'application/json', [PHOTONPAY_TOKEN_HEADER]: token },
        });
        return assertBusinessSuccess(await response.json(), SyncExecutionErrorCategory.BUSINESS_REJECTED, [
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
      if (cached && cached.expiresAt > Date.now()) return cached.token;
    } else {
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
      const raw = assertBusinessSuccess(await response.json(), SyncExecutionErrorCategory.CREDENTIAL_INVALID, [
        credential.appId, credential.appSecret, encodedCredential, authorization,
      ]);
      const data = extractDataObject(raw);
      const token = firstString(data.accessToken, data.access_token, data.token, raw.accessToken);
      if (!token) throw new ProviderRequestError(SyncExecutionErrorCategory.CREDENTIAL_INVALID, 'PhotonPay authentication response was invalid.');
      const expiresIn = Math.max(1, firstNumber(data.expiresIn, data.expires_in) ?? 7_200);
      const refreshLeadSeconds = Math.min(300, Math.max(60, Math.floor(expiresIn * 0.1)));
      const cacheLifetimeSeconds = Math.max(1, expiresIn - refreshLeadSeconds);
      this.tokenCache.set(cacheKey, { token, expiresAt: Date.now() + cacheLifetimeSeconds * 1_000 });
      return token;
    } catch (error) {
      throw redactProviderRequestError(error, [credential.appId, credential.appSecret, encodedCredential, authorization]);
    }
  }
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
  const code = redactSensitiveText(firstString(raw.code), sensitiveValues);
  if (code && code !== '0000') {
    const providerMessage = redactSensitiveText(firstString(raw.message, raw.msg), sensitiveValues);
    const requestId = redactSensitiveText(firstString(raw.requestId, raw.request_id, raw.traceId), sensitiveValues);
    throw new ProviderRequestError(
      category,
      `PhotonPay rejected the request. ${code}${providerMessage ? `: ${providerMessage}` : ''}`,
      200, code, providerMessage ?? undefined, requestId ?? undefined,
    );
  }
  return raw;
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
    createdAt: firstString(record.createdAt),
    updatedAt: firstString(record.updatedAt),
  };
}

function maskOnly(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `****${digits.slice(-4)}` : null;
}

function formatGmt8DateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? PHOTONPAY_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
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
