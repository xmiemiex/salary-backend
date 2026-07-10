import { SyncAutoExecutionService } from './sync-auto-execution.service';

describe('SyncAutoExecutionService safety boundary', () => {
  const previous = process.env.SYNC_AUTO_EXECUTION_ENABLED;
  afterAll(() => {
    if (previous === undefined) delete process.env.SYNC_AUTO_EXECUTION_ENABLED;
    else process.env.SYNC_AUTO_EXECUTION_ENABLED = previous;
  });

  it('does not query or call an adapter while disabled', async () => {
    process.env.SYNC_AUTO_EXECUTION_ENABLED = 'false';
    const prisma = { $transaction: jest.fn(), $queryRaw: jest.fn() };
    const adapters = { resolve: jest.fn() };
    const service = new SyncAutoExecutionService(prisma as never, {} as never, adapters as never, {} as never);
    await expect(service.poll()).resolves.toEqual({ claimedCount: 0, disabled: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(adapters.resolve).not.toHaveBeenCalled();
  });

  it('returns a safe status without lease owner or secrets', async () => {
    process.env.SYNC_AUTO_EXECUTION_ENABLED = 'false';
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ active: 1n, pending: 2n, waiting: 3n, failed: 4n }]) };
    const service = new SyncAutoExecutionService(prisma as never, {} as never, {} as never, {} as never);
    const status = await service.status();
    expect(status).toMatchObject({ enabled: false, activeLeaseCount: 1, pendingEligibleCount: 2, retryWaitingCount: 3, permanentlyFailedCount: 4 });
    expect(JSON.stringify(status)).not.toMatch(/leaseOwner|DATABASE_URL|token|secret/i);
  });
});
