import { Inject, Injectable, Optional } from '@nestjs/common';
import { providerFetch } from '../provider-request-error';

export const CAKE_DEFAULT_CONVERSIONS_PATH = '/api/1/reports.asmx/Conversions';
export const CAKE_FETCH = 'CAKE_FETCH';

export type CakeCredentialPayload = {
  apiKey: string;
  baseUrl: string;
  conversionsPath?: string;
  affiliateId?: string;
  campaignId?: string;
  offerId?: string;
};

export type CakeConversionRecord = Record<string, unknown>;

export type CakeConversionsResponse = {
  conversions: CakeConversionRecord[];
  raw: unknown;
};

type FetchLike = typeof fetch;

@Injectable()
export class CakeClient {
  constructor(@Optional() @Inject(CAKE_FETCH) private readonly fetchImpl: FetchLike = fetch) {}

  async getConversions(input: {
    credential: CakeCredentialPayload;
    startDate: string;
    endDate: string;
    startAtRow: number;
    rowLimit: number;
  }): Promise<CakeConversionsResponse> {
    const url = new URL(input.credential.conversionsPath ?? CAKE_DEFAULT_CONVERSIONS_PATH, normalizeBaseUrl(input.credential.baseUrl));
    url.searchParams.set('api_key', input.credential.apiKey);
    url.searchParams.set('start_date', input.startDate);
    url.searchParams.set('end_date', input.endDate);
    url.searchParams.set('start_at_row', String(input.startAtRow));
    url.searchParams.set('row_limit', String(input.rowLimit));
    url.searchParams.set('response_format', 'json');

    setOptionalParam(url, 'affiliate_id', input.credential.affiliateId);
    setOptionalParam(url, 'campaign_id', input.credential.campaignId);
    setOptionalParam(url, 'offer_id', input.credential.offerId);

    const response = await providerFetch(this.fetchImpl, 'CAKE', url, { method: 'GET', headers: { Accept: 'application/json' } });

    const raw = await response.json();
    return { conversions: extractConversions(raw), raw };
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function setOptionalParam(url: URL, name: string, value: string | undefined) {
  if (value) url.searchParams.set(name, value);
}

function extractConversions(raw: unknown): CakeConversionRecord[] {
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (!isRecord(raw)) return [];

  const candidates = [
    raw.conversions,
    raw.Conversions,
    raw.conversion,
    raw.Conversion,
    raw.rows,
    raw.Rows,
    raw.row,
    raw.Row,
    isRecord(raw.data) ? raw.data.conversions : undefined,
    isRecord(raw.data) ? raw.data.rows : undefined,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
    if (isRecord(candidate)) return [candidate];
  }

  return [];
}

function isRecord(value: unknown): value is CakeConversionRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
