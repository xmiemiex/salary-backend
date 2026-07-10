export type SyncPlannerConfig = {
  enabled: boolean;
  day: number;
  hour: number;
  timezone: 'Asia/Shanghai';
};

export function readSyncPlannerConfig(env: NodeJS.ProcessEnv = process.env): SyncPlannerConfig {
  const enabledText = env.SYNC_PLANNER_ENABLED ?? 'false';
  if (enabledText !== 'true' && enabledText !== 'false') {
    throw new Error('SYNC_PLANNER_ENABLED must be true or false.');
  }
  const day = parseInteger(env.SYNC_PLANNER_DAY ?? '10', 'SYNC_PLANNER_DAY', 1, 28);
  const hour = parseInteger(env.SYNC_PLANNER_HOUR ?? '9', 'SYNC_PLANNER_HOUR', 0, 23);
  const timezone = env.SYNC_PLANNER_TIMEZONE ?? 'Asia/Shanghai';
  if (timezone !== 'Asia/Shanghai') {
    throw new Error('SYNC_PLANNER_TIMEZONE must be Asia/Shanghai.');
  }
  return { enabled: enabledText === 'true', day, hour, timezone };
}

function parseInteger(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return parsed;
}

export function getPreviousGmt8Month(now = new Date()): Date {
  if (Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date.');
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1));
}

export function isPlannerDue(config: SyncPlannerConfig, now = new Date()): boolean {
  if (!config.enabled) return false;
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const day = local.getUTCDate();
  return day > config.day || (day === config.day && local.getUTCHours() >= config.hour);
}

export function monthText(month: Date): string {
  return month.toISOString().slice(0, 7);
}
