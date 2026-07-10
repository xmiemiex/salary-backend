import { getPreviousGmt8Month, isPlannerDue, readSyncPlannerConfig } from './sync-planner-config';

describe('sync planner config and GMT+8 schedule', () => {
  it('defaults to disabled, day 10, hour 9 and Asia/Shanghai', () => {
    expect(readSyncPlannerConfig({})).toEqual({ enabled: false, day: 10, hour: 9, timezone: 'Asia/Shanghai' });
  });
  it.each([
    [{ SYNC_PLANNER_ENABLED: 'yes' }, 'SYNC_PLANNER_ENABLED'],
    [{ SYNC_PLANNER_DAY: '0' }, 'SYNC_PLANNER_DAY'],
    [{ SYNC_PLANNER_DAY: '29' }, 'SYNC_PLANNER_DAY'],
    [{ SYNC_PLANNER_DAY: 'x' }, 'SYNC_PLANNER_DAY'],
    [{ SYNC_PLANNER_HOUR: '24' }, 'SYNC_PLANNER_HOUR'],
    [{ SYNC_PLANNER_HOUR: '-1' }, 'SYNC_PLANNER_HOUR'],
    [{ SYNC_PLANNER_TIMEZONE: 'UTC' }, 'SYNC_PLANNER_TIMEZONE'],
  ])('rejects invalid startup configuration %#', (env, name) => {
    expect(() => readSyncPlannerConfig(env)).toThrow(name);
  });
  it('calculates the prior GMT+8 month and crosses January safely', () => {
    expect(getPreviousGmt8Month(new Date('2026-07-10T01:00:00.000Z')).toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(getPreviousGmt8Month(new Date('2026-01-10T01:00:00.000Z')).toISOString()).toBe('2025-12-01T00:00:00.000Z');
  });
  it('does not run while disabled and becomes due at the configured GMT+8 hour', () => {
    const disabled = readSyncPlannerConfig({});
    expect(isPlannerDue(disabled, new Date('2026-07-20T00:00:00Z'))).toBe(false);
    const enabled = readSyncPlannerConfig({ SYNC_PLANNER_ENABLED: 'true' });
    expect(isPlannerDue(enabled, new Date('2026-07-10T00:59:59Z'))).toBe(false);
    expect(isPlannerDue(enabled, new Date('2026-07-10T01:00:00Z'))).toBe(true);
    expect(isPlannerDue(enabled, new Date('2026-07-20T00:00:00Z'))).toBe(true);
  });
});
