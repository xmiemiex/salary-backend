import { Inject, Injectable, Optional } from '@nestjs/common';
import { providerFetch } from '../provider-request-error';

export const CAKE_DEFAULT_CONVERSIONS_PATH = 'Reports/Conversions';
export const CAKE_DEFAULT_SUBAFFILIATE_SUMMARY_PATH = 'Reports/SubAffiliateSummary';
export const CAKE_CAMPAIGN_SUMMARY_PATH = 'Reports/CampaignSummary';
export const CAKE_DISPOSITION_TYPES_PATH = 'Lists/DispositionTypes';
export const CAKE_CURRENCIES_PATH = 'Lists/Currencies';
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
export type CakeCampaignSummaryRecord = Record<string, unknown>;
export type CakeDispositionTypeRecord = Record<string, unknown>;
export type CakeCurrencyRecord = Record<string, unknown>;
export type CakeSubAffiliateSummaryRecord = Record<string, unknown>;

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

  async getSubAffiliateSummary(input: {
    credential: CakeCredentialPayload;
    startDate: string;
    endDate: string;
    affiliateId: string;
  }) {
    const configuredPath = input.credential.conversionsPath;
    const summaryPath = configuredPath
      ? configuredPath.replace(/Reports\/Conversions$/i, CAKE_DEFAULT_SUBAFFILIATE_SUMMARY_PATH)
      : CAKE_DEFAULT_SUBAFFILIATE_SUMMARY_PATH;
    const url = this.buildAuthenticatedUrl(summaryPath, input.credential, input.affiliateId);
    url.searchParams.set('start_date', input.startDate);
    url.searchParams.set('end_date', input.endDate);
    url.searchParams.set('offer_id', '0');
    url.searchParams.set('response_format', 'json');
    const response = await providerFetch(this.fetchImpl, 'CAKE', url, {
      method: 'GET',
      headers: { Accept: 'application/json, application/xml, text/xml' },
    });
    const raw = await readJsonOrSubAffiliateXml(response);
    return {
      rows: extractRows(raw) as CakeSubAffiliateSummaryRecord[],
      rowCount: extractRowCount(raw),
      httpStatus: typeof response.status === 'number' ? response.status : 200,
      raw,
    };
  }

  async getCampaignSummary(input: {
    credential: CakeCredentialPayload;
    startDate: string;
    endDate: string;
    affiliateId: string;
    rowLimit: number;
  }) {
    const url = this.buildAuthenticatedUrl(CAKE_CAMPAIGN_SUMMARY_PATH, input.credential, input.affiliateId);
    url.searchParams.set('start_date', input.startDate);
    url.searchParams.set('end_date', input.endDate);
    url.searchParams.set('conversion_type', 'conversions');
    url.searchParams.set('start_at_row', '1');
    url.searchParams.set('row_limit', String(input.rowLimit));
    url.searchParams.set('response_format', 'json');
    ['offer_id', 'offer_name', 'price', 'conversions', 'revenue', 'currency_id', 'currency_symbol'].forEach((field) =>
      url.searchParams.append('fields', field),
    );
    return this.fetchRows<CakeCampaignSummaryRecord>(url);
  }

  async getDispositionTypes(input: {
    credential: CakeCredentialPayload;
    affiliateId: string;
  }) {
    const url = this.buildAuthenticatedUrl(CAKE_DISPOSITION_TYPES_PATH, input.credential, input.affiliateId);
    url.searchParams.set('response_format', 'json');
    return this.fetchRows<CakeDispositionTypeRecord>(url);
  }

  async getCurrencies(input: {
    credential: CakeCredentialPayload;
    affiliateId: string;
  }) {
    const url = this.buildAuthenticatedUrl(CAKE_CURRENCIES_PATH, input.credential, input.affiliateId);
    url.searchParams.set('response_format', 'json');
    return this.fetchRows<CakeCurrencyRecord>(url);
  }

  private buildAuthenticatedUrl(path: string, credential: CakeCredentialPayload, affiliateId: string) {
    const url = new URL(path, normalizeBaseUrl(credential.baseUrl));
    url.searchParams.set('api_key', credential.apiKey);
    url.searchParams.set('affiliate_id', affiliateId);
    return url;
  }

  private async fetchRows<T extends Record<string, unknown>>(url: URL) {
    const response = await providerFetch(this.fetchImpl, 'CAKE', url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const raw = await response.json();
    return {
      rows: extractRows(raw) as T[],
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

function extractRows(raw: unknown): CakeConversionRecord[] {
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (!isRecord(raw)) return [];
  const candidates = [
    raw.subAffiliates,
    raw.SubAffiliates,
    raw.sub_affiliates,
    raw.SubAffiliate,
    raw.rows,
    raw.Rows,
    isRecord(raw.data) ? raw.data.subAffiliates : undefined,
    isRecord(raw.data) ? raw.data.SubAffiliate : undefined,
    isRecord(raw.data) ? raw.data.rows : undefined,
    raw.data,
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

async function readJsonOrSubAffiliateXml(response: Response): Promise<unknown> {
  if (typeof response.text !== 'function') return response.json();
  const body = await response.text();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    const rows = [...body.matchAll(/<SubAffiliate(?:\s[^>]*)?>([\s\S]*?)<\/SubAffiliate>/gi)].map((match) => ({
      sub_id: xmlValue(match[1], 'sub_id'),
      impressions: xmlValue(match[1], 'impressions'),
      clicks: xmlValue(match[1], 'clicks'),
      conversions: xmlValue(match[1], 'conversions'),
      conversion_rate: xmlValue(match[1], 'conversion_rate'),
      revenue: xmlValue(match[1], 'revenue'),
      epc: xmlValue(match[1], 'epc'),
    }));
    if (rows.length === 0 && !/<ArrayOfSubAffiliate(?:\s|>)/i.test(body)) {
      throw new Error('CAKE SubAffiliateSummary returned an unsupported response format.');
    }
    return rows;
  }
}

function xmlValue(block: string, tag: string) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
  if (!match) return '';
  return match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}
