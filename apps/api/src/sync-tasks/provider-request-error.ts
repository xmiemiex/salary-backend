import { Prisma, SyncExecutionErrorCategory } from '@prisma/client';

const REQUEST_TIMEOUT_MS = 30_000;

export class ProviderRequestError extends Error {
  constructor(
    readonly category: SyncExecutionErrorCategory,
    message: string,
    readonly httpStatus?: number,
    readonly providerCode?: string,
    readonly providerMessage?: string,
    readonly requestId?: string,
    readonly apiVersion?: string,
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
  if (!response.ok) {
    const details = await readProviderErrorDetails(response);
    throw providerHttpError(provider, response.status, details);
  }
  return response;
}

export function providerHttpError(
  provider: string,
  status: number,
  details: { code?: string; message?: string; requestId?: string; apiVersion?: string } = {},
): ProviderRequestError {
  const suffix = [details.code, details.message].filter(Boolean).join(': ');
  const message = status === 429
    ? `${provider} request was rate limited.`
    : status >= 500
      ? `${provider} service is temporarily unavailable.`
      : status === 401 || status === 403
        ? `${provider} rejected the configured credential.`
        : `${provider} rejected the request.`;
  const category = status === 429
    ? SyncExecutionErrorCategory.RATE_LIMITED
    : status >= 500
      ? SyncExecutionErrorCategory.PROVIDER_5XX
      : status === 401 || status === 403
        ? SyncExecutionErrorCategory.CREDENTIAL_INVALID
        : SyncExecutionErrorCategory.BUSINESS_REJECTED;
  return new ProviderRequestError(
    category,
    suffix ? `${message} ${suffix}` : message,
    status,
    details.code,
    details.message,
    details.requestId,
    details.apiVersion,
  );
}

export function providerErrorCategory(error: unknown): SyncExecutionErrorCategory {
  if (error instanceof ProviderRequestError) return error.category;
  if (error instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P2024', 'P2034'].includes(error.code)) {
    return SyncExecutionErrorCategory.TEMPORARY_DATABASE_ERROR;
  }
  return SyncExecutionErrorCategory.BUSINESS_REJECTED;
}

async function readProviderErrorDetails(response: Response) {
  const requestId = firstHeader(response.headers, ['x-request-id', 'request-id', 'x-airwallex-request-id', 'trace-id']);
  const apiVersion = firstHeader(response.headers, ['x-api-version', 'api-version']);
  try {
    const raw = await response.clone().json() as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { requestId, apiVersion };
    const record = raw as Record<string, unknown>;
    const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : undefined;
    return {
      code: safeScalar(record.code ?? record.error_code ?? nested?.code),
      message: safeScalar(record.message ?? record.error_message ?? nested?.message),
      requestId: requestId ?? safeScalar(record.request_id ?? record.requestId),
      apiVersion,
    };
  } catch {
    return { requestId, apiVersion };
  }
}

function firstHeader(headers: Headers, names: string[]): string | undefined {
  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value) return value.slice(0, 255);
  }
  return undefined;
}

function safeScalar(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim().replace(/[\r\n\t]+/g, ' ');
  return text ? text.slice(0, 500) : undefined;
}
