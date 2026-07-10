import { Prisma, SyncExecutionErrorCategory } from '@prisma/client';

const REQUEST_TIMEOUT_MS = 30_000;

export class ProviderRequestError extends Error {
  constructor(
    readonly category: SyncExecutionErrorCategory,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

export async function providerFetch(fetchImpl: typeof fetch, provider: string, input: URL, init: RequestInit): Promise<Response> {
  let response: Response;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    response = await fetchImpl(input, { ...init, signal });
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    const errorName = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
    const timeout = signal.aborted || errorName === 'AbortError' || errorName === 'TimeoutError';
    throw new ProviderRequestError(
      timeout ? SyncExecutionErrorCategory.TIMEOUT : SyncExecutionErrorCategory.NETWORK_ERROR,
      timeout ? `${provider} request timed out.` : `${provider} network request failed.`,
    );
  }
  if (!response.ok) throw providerHttpError(provider, response.status);
  return response;
}

export function providerHttpError(provider: string, status: number): ProviderRequestError {
  if (status === 429) return new ProviderRequestError(SyncExecutionErrorCategory.RATE_LIMITED, `${provider} request was rate limited.`, status);
  if (status >= 500) return new ProviderRequestError(SyncExecutionErrorCategory.PROVIDER_5XX, `${provider} service is temporarily unavailable.`, status);
  if (status === 401 || status === 403) return new ProviderRequestError(SyncExecutionErrorCategory.CREDENTIAL_INVALID, `${provider} rejected the configured credential.`, status);
  return new ProviderRequestError(SyncExecutionErrorCategory.BUSINESS_REJECTED, `${provider} rejected the request.`, status);
}

export function providerErrorCategory(error: unknown): SyncExecutionErrorCategory {
  if (error instanceof ProviderRequestError) return error.category;
  if (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P2024', 'P2034'].includes(error.code)) {
    return SyncExecutionErrorCategory.TEMPORARY_DATABASE_ERROR;
  }
  return SyncExecutionErrorCategory.BUSINESS_REJECTED;
}
