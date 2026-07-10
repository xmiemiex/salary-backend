import { Inject, Injectable, Optional } from '@nestjs/common';
import { providerFetch } from '../provider-request-error';

export const EVERFLOW_API_KEY_HEADER = 'X-Eflow-Api-Key';
export const EVERFLOW_DEFAULT_BASE_URL = 'https://api.eflow.team';

export type EverflowCredentialPayload = {
  apiKey: string;
  baseUrl?: string;
};

export type EverflowConversionRecord = Record<string, unknown>;

export type EverflowConversionsResponse = {
  conversions?: EverflowConversionRecord[];
  paging?: {
    page?: number;
    page_size?: number;
    total_count?: number;
  };
};

type FetchLike = typeof fetch;
export const EVERFLOW_FETCH = 'EVERFLOW_FETCH';

@Injectable()
export class EverflowClient {
  constructor(@Optional() @Inject(EVERFLOW_FETCH) private readonly fetchImpl: FetchLike = fetch) {}

  async searchAffiliateConversions(input: {
    credential: EverflowCredentialPayload;
    from: string;
    to: string;
    timezoneId: number;
    page: number;
    pageSize: number;
  }): Promise<EverflowConversionsResponse> {
    const url = new URL('/v1/affiliates/reporting/conversions', normalizeBaseUrl(input.credential.baseUrl));
    const response = await providerFetch(this.fetchImpl, 'Everflow', url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [EVERFLOW_API_KEY_HEADER]: input.credential.apiKey,
      },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        timezone_id: input.timezoneId,
        show_conversions: true,
        show_events: false,
        query: { filters: [] },
        page: input.page,
        page_size: input.pageSize,
      }),
    });

    return (await response.json()) as EverflowConversionsResponse;
  }
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? EVERFLOW_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
}
