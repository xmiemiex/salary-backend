import { SyncAutoExecutorScheduler } from './sync-auto-executor.scheduler';

describe('SyncAutoExecutorScheduler', () => {
  const previous = process.env.SYNC_AUTO_EXECUTION_ENABLED;
  afterEach(() => jest.useRealTimers());
  afterAll(() => { if (previous === undefined) delete process.env.SYNC_AUTO_EXECUTION_ENABLED; else process.env.SYNC_AUTO_EXECUTION_ENABLED = previous; });

  it('does not poll when disabled', () => {
    process.env.SYNC_AUTO_EXECUTION_ENABLED = 'false';
    const execution = { poll: jest.fn() };
    new SyncAutoExecutorScheduler(execution as never).onApplicationBootstrap();
    expect(execution.poll).not.toHaveBeenCalled();
  });

  it('stops new claims and waits for an in-flight poll during graceful shutdown', async () => {
    process.env.SYNC_AUTO_EXECUTION_ENABLED = 'true';
    process.env.SYNC_AUTO_EXECUTION_POLL_SECONDS = '1';
    process.env.SYNC_AUTO_EXECUTION_LEASE_SECONDS = '2';
    let finish!: () => void;
    const poll = jest.fn().mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const scheduler = new SyncAutoExecutorScheduler({ poll } as never);
    scheduler.onApplicationBootstrap();
    expect(poll).toHaveBeenCalledTimes(1);
    const shutdown = scheduler.onModuleDestroy();
    finish();
    await shutdown;
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
