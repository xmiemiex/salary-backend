import { SyncAdapterContext } from './sync-adapter';

/** Conservative allowlist: unknown/special modes never certify the monthly ledger. */
export function isMonthlyLedgerRequest(payload: unknown): boolean {
  if (payload == null) return true;
  return typeof payload === 'object' && !Array.isArray(payload)
    && Object.keys(payload).every(key => key === 'settlementMonth');
}

/** Called only by full-account adapters after all pages and ledger writes succeed. */
export function monthlyCoverage(context: SyncAdapterContext, status: string, failedCount: number) {
  if (status !== 'completed' || failedCount !== 0 || !isMonthlyLedgerRequest(context.requestPayload)) return null;
  const month = context.settlementMonth;
  const from = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1) - 8 * 3600000);
  const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1) - 8 * 3600000);
  const through = new Date(Math.min(end.getTime(), (context.coverageStartedAt ?? new Date()).getTime()));
  if (through <= from) return null;
  return { version: 1, scope: 'all_accounts_cards', posted: true, from: from.toISOString(), through: through.toISOString(), month: month.toISOString().slice(0, 7) };
}

export function readMonthlyCoverage(payload: unknown, month: string) {
  const proof = (payload as { monthlyCoverage?: Record<string, unknown> } | null)?.monthlyCoverage;
  const from = new Date(`${month}-01T00:00:00+08:00`);
  const end = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 2, 1) - 8 * 3600000);
  if (!proof || proof.version !== 1 || proof.scope !== 'all_accounts_cards' || proof.posted !== true || proof.month !== month
    || proof.from !== from.toISOString() || typeof proof.through !== 'string') return null;
  const through = new Date(proof.through);
  return Number.isFinite(through.getTime()) && through > from && through <= end ? through : null;
}
