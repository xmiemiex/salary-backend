import { HealthService } from './health.service';

describe('HealthService', () => {
  it('reports ready after SELECT 1 succeeds', async () => {
    const query = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    const service = new HealthService({ $queryRawUnsafe: query } as never);

    await expect(service.isDatabaseReady()).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('reports not ready without exposing a database error', async () => {
    const query = jest.fn().mockRejectedValue(new Error('password=secret DATABASE_URL=private'));
    const service = new HealthService({ $queryRawUnsafe: query } as never);

    await expect(service.isDatabaseReady()).resolves.toBe(false);
  });
});
