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
});
