import { Inject, Injectable, Optional } from '@nestjs/common';
import { ProviderRequestError, providerFetch } from '../provider-request-error';
import { SyncExecutionErrorCategory } from '@prisma/client';

export const AIRWALLEX_DEFAULT_BASE_URL = 'https://api.airwallex.com';
export const AIRWALLEX_DEFAULT_TRANSACTIONS_PATH = '/api/v1/issuing/transactions';
export const AIRWALLEX_DEFAULT_CARDS_PATH = '/api/v1/issuing/cards';
export const AIRWALLEX_DEFAULT_CARDHOLDERS_PATH = '/api/v1/issuing/cardholders';
export const AIRWALLEX_BUSINESS_ACCOUNT_API_VERSION = '2024-02-22';
export const AIRWALLEX_FETCH = 'AIRWALLEX_FETCH';
export const AIRWALLEX_CLIENT_ID_HEADER = 'x-client-id';
export const AIRWALLEX_API_KEY_HEADER = 'x-api-key';

export type AirwallexCredentialPayload = {
  clientId: string;
  apiKey: string;
  baseUrl?: string;
  transactionsPath?: string;
  cardsPath?: string;
  cardholdersPath?: string;
  apiVersion?: string;
  settlementDelayDays?: number;
};

export type AirwallexTransactionRecord = Record<string, unknown>;

export type AirwallexTransactionsResponse = {
  transactions: AirwallexTransactionRecord[];
  raw: unknown;
  hasMore: boolean;
};

export type AirwallexCardsResponse = {
  cards: AirwallexTransactionRecord[];
  hasMore: boolean;
};

export type AirwallexCardholdersResponse = {
  cardholders: AirwallexTransactionRecord[];
  hasMore: boolean;
};

type FetchLike = typeof fetch;

@Injectable()
export class AirwallexClient {
  constructor(@Optional() @Inject(AIRWALLEX_FETCH) private readonly fetchImpl: FetchLike = fetch) {}

  async listCardTransactions(input: {
    credential: AirwallexCredentialPayload;
    from: Date;
    to: Date;
    page: number;
    pageSize: number;
  }): Promise<AirwallexTransactionsResponse> {
    const token = await this.login(input.credential);
    const url = new URL(input.credential.transactionsPath ?? AIRWALLEX_DEFAULT_TRANSACTIONS_PATH, normalizeBaseUrl(input.credential.baseUrl));
    url.searchParams.set('from_created_at', input.from.toISOString());
    url.searchParams.set('to_created_at', input.to.toISOString());
    url.searchParams.set('page_num', String(input.page));
    url.searchParams.set('page_size', String(input.pageSize));

    const response = await providerFetch(this.fetchImpl, 'Airwallex', url, {
      method: 'GET',
      headers: this.authorizedHeaders(token, input.credential),
    });
    const raw = await response.json();
    return {
      transactions: extractTransactions(raw),
      raw,
      hasMore: hasMore(raw, input.page, input.pageSize),
    };
  }

  async listCards(input: {
    credential: AirwallexCredentialPayload;
    page: number;
    pageSize: number;
    from: Date;
    to: Date;
  }): Promise<AirwallexCardsResponse> {
    const token = await this.login(input.credential);
    const url = new URL(input.credential.cardsPath ?? AIRWALLEX_DEFAULT_CARDS_PATH, normalizeBaseUrl(input.credential.baseUrl));
    url.searchParams.set('from_created_at', input.from.toISOString());
    url.searchParams.set('to_created_at', input.to.toISOString());
    url.searchParams.set('page_num', String(input.page));
    url.searchParams.set('page_size', String(input.pageSize));

    const response = await providerFetch(this.fetchImpl, 'Airwallex', url, {
      method: 'GET',
      headers: this.authorizedHeaders(token, input.credential),
    });
    const raw = await response.json();
    return {
      cards: extractItems(raw),
      hasMore: hasMore(raw, input.page, input.pageSize),
    };
  }

  async listCardholders(input: {
    credential: AirwallexCredentialPayload;
    page: number;
    pageSize: number;
  }): Promise<AirwallexCardholdersResponse> {
    const token = await this.login(input.credential);
    const url = new URL(input.credential.cardholdersPath ?? AIRWALLEX_DEFAULT_CARDHOLDERS_PATH, normalizeBaseUrl(input.credential.baseUrl));
    url.searchParams.set('page_num', String(input.page));
    url.searchParams.set('page_size', String(input.pageSize));

    const response = await providerFetch(this.fetchImpl, 'Airwallex', url, {
      method: 'GET',
      headers: this.authorizedHeaders(token, input.credential),
    });
    const raw = await response.json();
    return {
      cardholders: extractItems(raw),
      hasMore: hasMore(raw, input.page, input.pageSize),
    };
  }

  private authorizedHeaders(token: string, credential: AirwallexCredentialPayload): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-api-version': credential.apiVersion ?? AIRWALLEX_BUSINESS_ACCOUNT_API_VERSION,
    };
  }

  private async login(credential: AirwallexCredentialPayload): Promise<string> {
    const url = new URL('/api/v1/authentication/login', normalizeBaseUrl(credential.baseUrl));
    const response = await providerFetch(this.fetchImpl, 'Airwallex', url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [AIRWALLEX_CLIENT_ID_HEADER]: credential.clientId,
        [AIRWALLEX_API_KEY_HEADER]: credential.apiKey,
      },
    });
    const raw = await response.json();
    const token = extractToken(raw);
    if (!token) throw new ProviderRequestError(SyncExecutionErrorCategory.CREDENTIAL_INVALID, 'Airwallex authentication response was invalid.');
    return token;
  }
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? AIRWALLEX_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function extractToken(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  return firstString(raw.token, raw.authToken, raw.access_token, raw.accessToken, isRecord(raw.data) ? raw.data.token : undefined);
}

function extractTransactions(raw: unknown): AirwallexTransactionRecord[] {
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (!isRecord(raw)) return [];

  const candidates = [
    raw.items,
    raw.transactions,
    raw.data,
    isRecord(raw.data) ? raw.data.items : undefined,
    isRecord(raw.data) ? raw.data.transactions : undefined,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function extractItems(raw: unknown): AirwallexTransactionRecord[] {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return [];
  return raw.items.filter(isRecord);
}

function hasMore(raw: unknown, page: number, pageSize: number): boolean {
  if (!isRecord(raw)) return false;
  if (typeof raw.has_more === 'boolean') return raw.has_more;
  const total = firstNumber(raw.total_count, raw.total, isRecord(raw.page) ? raw.page.total_count : undefined);
  const items = extractTransactions(raw);
  if (typeof total === 'number') return (page + 1) * pageSize < total;
  return items.length >= pageSize;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function isRecord(value: unknown): value is AirwallexTransactionRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
