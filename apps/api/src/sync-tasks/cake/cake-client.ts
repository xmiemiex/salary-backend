import { Inject, Injectable, Optional } from '@nestjs/common';
import { providerFetch } from '../provider-request-error';

export const CAKE_DEFAULT_CONVERSIONS_PATH = 'Reports/Conversions';
export const CAKE_FETCH = 'CAKE_FETCH';
const CAKE_CONVERSION_FIELDS = [
  'conversion_id',
  'event_id',
  'event_name',
  'tracking_id',
  'conversion_date',
  'offer_id',
  'offer_name',
  'campaign_name',
  'creative_id',
  'creative_name',
  'subid_1',
  'subid_2',
  'subid_3',
  'subid_4',
  'subid_5',
  'price',
  'disposition',
] as const;

export type CakeCredentialPayload = {
  apiKey: string;
  baseUrl: string;
  conversionsPath?: string;
};

export type CakeConversionRecord = Record<string, unknown>;

export type CakeConversionsResponse = {
  conversions: CakeConversionRecord[];
  rowCount: number | null;
  httpStatus: number;
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
    affiliateId: string;
  }): Promise<CakeConversionsResponse> {
    const url = new URL(
      input.credential.conversionsPath ?? CAKE_DEFAULT_CONVERSIONS_PATH,
      normalizeBaseUrl(input.credential.baseUrl),
    );
    url.searchParams.set('api_key', input.credential.apiKey);
    url.searchParams.set('affiliate_id', input.affiliateId);
    url.searchParams.set('start_date', input.startDate);
    url.searchParams.set('end_date', input.endDate);
    url.searchParams.set('start_at_row', String(input.startAtRow));
    url.searchParams.set('row_limit', String(input.rowLimit));
    url.searchParams.set('response_format', 'json');
    url.searchParams.set('sort_field', 'conversion_date');
    url.searchParams.set('sort_descending', 'false');
    CAKE_CONVERSION_FIELDS.forEach((field) => url.searchParams.append('fields', field));

    const response = await providerFetch(this.fetchImpl, 'CAKE', url, { method: 'GET', headers: { Accept: 'application/json' } });

    const raw = await response.json();
    return {
      conversions: extractConversions(raw),
      rowCount: extractRowCount(raw),
      httpStatus: typeof response.status === 'number' ? response.status : 200,
      raw,
    };
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/`;
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
    raw.data,
    isRecord(raw.data) ? raw.data.conversions : undefined,
    isRecord(raw.data) ? raw.data.rows : undefined,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
    if (isRecord(candidate)) return [candidate];
  }

  return [];
}

function extractRowCount(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const value = raw.row_count ?? raw.rowCount;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is CakeConversionRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
