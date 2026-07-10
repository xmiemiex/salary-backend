import { createHmac } from 'crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { providerFetch } from '../provider-request-error';

export const PHOTONPAY_DEFAULT_BASE_URL = 'https://api.photonpay.com';
export const PHOTONPAY_DEFAULT_TRANSACTIONS_PATH = '/openapi/v1/issuing/transactions';
export const PHOTONPAY_FETCH = 'PHOTONPAY_FETCH';
export const PHOTONPAY_API_KEY_HEADER = 'x-api-key';
export const PHOTONPAY_TOKEN_HEADER = 'authorization';
export const PHOTONPAY_MERCHANT_ID_HEADER = 'x-merchant-id';
export const PHOTONPAY_TIMESTAMP_HEADER = 'x-timestamp';
export const PHOTONPAY_SIGNATURE_HEADER = 'x-signature';

export type PhotonPayCredentialPayload = {
  baseUrl?: string;
  transactionsPath?: string;
  apiKey?: string;
  token?: string;
  secret?: string;
  merchantId?: string;
  settlementDelayDays?: number;
};

export type PhotonPayTransactionRecord = Record<string, unknown>;

export type PhotonPayTransactionsResponse = {
  transactions: PhotonPayTransactionRecord[];
  raw: unknown;
  hasMore: boolean;
};

type FetchLike = typeof fetch;

@Injectable()
export class PhotonPayClient {
  constructor(@Optional() @Inject(PHOTONPAY_FETCH) private readonly fetchImpl: FetchLike = fetch) {}

  async listCardTransactions(input: {
    credential: PhotonPayCredentialPayload;
    from: Date;
    to: Date;
    page: number;
    pageSize: number;
  }): Promise<PhotonPayTransactionsResponse> {
    const path = input.credential.transactionsPath ?? PHOTONPAY_DEFAULT_TRANSACTIONS_PATH;
    const url = new URL(path, normalizeBaseUrl(input.credential.baseUrl));
    url.searchParams.set('from', input.from.toISOString());
    url.searchParams.set('to', input.to.toISOString());
    url.searchParams.set('startTime', input.from.toISOString());
    url.searchParams.set('endTime', input.to.toISOString());
    url.searchParams.set('page', String(input.page));
    url.searchParams.set('pageSize', String(input.pageSize));

    const timestamp = new Date().toISOString();
    const response = await providerFetch(this.fetchImpl, 'PhotonPay', url, {
      method: 'GET',
      headers: this.buildHeaders(input.credential, 'GET', url, timestamp),
    });
    const raw = await response.json();
    return {
      transactions: extractTransactions(raw),
      raw,
      hasMore: hasMore(raw, input.page, input.pageSize),
    };
  }

  private buildHeaders(credential: PhotonPayCredentialPayload, method: string, url: URL, timestamp: string): HeadersInit {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (credential.apiKey) headers[PHOTONPAY_API_KEY_HEADER] = credential.apiKey;
    if (credential.token) headers[PHOTONPAY_TOKEN_HEADER] = `Bearer ${credential.token}`;
    if (credential.merchantId) headers[PHOTONPAY_MERCHANT_ID_HEADER] = credential.merchantId;
    if (credential.secret) {
      headers[PHOTONPAY_TIMESTAMP_HEADER] = timestamp;
      headers[PHOTONPAY_SIGNATURE_HEADER] = signRequest(credential.secret, method, url, timestamp);
    }
    return headers;
  }
}

export function signPhotonPayRequest(secret: string, method: string, url: URL, timestamp: string): string {
  return signRequest(secret, method, url, timestamp);
}

function signRequest(secret: string, method: string, url: URL, timestamp: string): string {
  const payload = [method.toUpperCase(), url.pathname, url.searchParams.toString(), timestamp].join('\n');
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? PHOTONPAY_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function extractTransactions(raw: unknown): PhotonPayTransactionRecord[] {
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (!isRecord(raw)) return [];

  const candidates = [
    raw.items,
    raw.records,
    raw.transactions,
    raw.list,
    raw.data,
    isRecord(raw.data) ? raw.data.items : undefined,
    isRecord(raw.data) ? raw.data.records : undefined,
    isRecord(raw.data) ? raw.data.transactions : undefined,
    isRecord(raw.data) ? raw.data.list : undefined,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function hasMore(raw: unknown, page: number, pageSize: number): boolean {
  if (!isRecord(raw)) return false;
  const total = firstNumber(raw.total, raw.totalCount, raw.total_count, isRecord(raw.data) ? raw.data.total : undefined);
  const items = extractTransactions(raw);
  if (typeof total === 'number') return page * pageSize < total;
  const hasNext = firstBoolean(raw.hasMore, raw.has_more, isRecord(raw.data) ? raw.data.hasMore : undefined);
  if (typeof hasNext === 'boolean') return hasNext;
  return items.length >= pageSize;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function isRecord(value: unknown): value is PhotonPayTransactionRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
