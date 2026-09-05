import { SyncExecutionErrorCategory } from '@prisma/client';
import { providerFetch, providerHttpError } from './provider-request-error';
import { withProviderBudget } from './provider-execution-budget';

describe('provider request error classification', () => {
  it('aborts an exhausted source budget without aborting an independent source', async () => {
    const hanging = jest.fn((_url, init) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const slow = withProviderBudget(20, () => providerFetch(hanging as never, 'slow', new URL('https://example.test'), {}));
    const independent = withProviderBudget(1000, () => providerFetch(jest.fn().mockResolvedValue(new Response('{}')), 'fast', new URL('https://example.test'), {}));
    await expect(independent).resolves.toBeInstanceOf(Response);
    await expect(slow).rejects.toMatchObject({ category: 'TIMEOUT' });
  });
  it.each([[429, SyncExecutionErrorCategory.RATE_LIMITED], [500, SyncExecutionErrorCategory.PROVIDER_5XX], [503, SyncExecutionErrorCategory.PROVIDER_5XX], [401, SyncExecutionErrorCategory.CREDENTIAL_INVALID], [400, SyncExecutionErrorCategory.BUSINESS_REJECTED]])(
    'classifies HTTP %s', (status, category) => expect(providerHttpError('provider', status).category).toBe(category),
  );
  it('classifies timeouts without retaining a provider response', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(Object.assign(new Error('secret response'), { name: 'TimeoutError' }));
    await expect(providerFetch(fetchImpl, 'provider', new URL('http://localhost'), {})).rejects.toMatchObject({ category: SyncExecutionErrorCategory.TIMEOUT, message: 'provider request timed out.' });
  });

  it('retains allowlisted official error diagnostics for support without retaining the raw body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'invalid_request', message: 'Cards product is unavailable', request_id: 'body-request' }), {
      status: 400,
      headers: { 'content-type': 'application/json', 'x-request-id': 'header-request', 'x-api-version': '2024-02-22' },
    }));
    await expect(providerFetch(fetchImpl, 'Airwallex', new URL('https://example.test/api/v1/issuing/cards'), {})).rejects.toMatchObject({
      category: SyncExecutionErrorCategory.BUSINESS_REJECTED,
      httpStatus: 400,
      providerCode: 'invalid_request',
      providerMessage: 'Cards product is unavailable',
      requestId: 'header-request',
      apiVersion: '2024-02-22',
    });
  });
});
