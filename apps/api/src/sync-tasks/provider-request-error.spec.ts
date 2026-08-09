import { SyncExecutionErrorCategory } from '@prisma/client';
import { providerFetch, providerHttpError } from './provider-request-error';

describe('provider request error classification', () => {
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
