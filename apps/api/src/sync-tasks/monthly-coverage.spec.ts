import { hasSufficientMonthlyCoverage, monthlyCoverage, monthlyCoverageRequirement, readMonthlyCoverage } from './monthly-coverage';
import { SyncAdapterContext } from './sync-adapter';

describe('monthly posted coverage contract', () => {
  const context = { settlementMonth: new Date('2026-01-01'), coverageStartedAt: new Date('2026-01-15T03:00:00Z'), requestPayload: { settlementMonth: '2026-01' } } as SyncAdapterContext;
  it('freezes month-to-date coverage at execution start, with GMT+8 boundaries across the year', () => {
    const proof = monthlyCoverage(context, 'completed', 0);
    expect(proof).toMatchObject({ from: '2025-12-31T16:00:00.000Z', through: '2026-01-15T03:00:00.000Z', posted: true });
    expect(readMonthlyCoverage({ monthlyCoverage: proof }, '2026-01')?.toISOString()).toBe('2026-01-15T03:00:00.000Z');
    expect(readMonthlyCoverage({ monthlyCoverage: proof }, '2026-02')).toBeNull();
  });
  it('certifies neither failure nor unknown, preview, calibration or subset modes', () => {
    expect(monthlyCoverage(context, 'failed', 1)).toBeNull();
    expect(monthlyCoverage(context, 'completed', 1)).toBeNull();
    for (const requestPayload of [{ previewOnly: true }, { historicalBackfill: { previewOnly: false } }, { inventoryOnly: true }, { verificationWindow: {} }, { targetCardIds: [] }, { calibration: true }]) {
      expect(monthlyCoverage({ ...context, requestPayload }, 'completed', 0)).toBeNull();
    }
  });
  it('caps completed historical coverage at month end and rejects incomplete or out-of-range evidence', () => {
    const proof = monthlyCoverage({ ...context, coverageStartedAt: new Date('2026-09-01') }, 'completed', 0)!;
    expect(proof.through).toBe('2026-01-31T16:00:00.000Z');
    for (const changed of [{ posted: false }, { scope: 'subset' }, { through: '2026-02-01T00:00:00Z' }, { through: 'bad-date' }]) expect(readMonthlyCoverage({ monthlyCoverage: { ...proof, ...changed } }, '2026-01')).toBeNull();
  });
});


describe('coverage sufficiency at deterministic GMT+8 boundaries', () => {
  it.each([
    ['2026-08', '2026-08-31T16:00:00.000Z'],
    ['2025-12', '2025-12-31T16:00:00.000Z'],
    ['2024-02', '2024-02-29T16:00:00.000Z'],
  ])('changes %s snapshots to historical coverage exactly at %s', (month, ending) => {
    const mid = new Date(`${month}-15T00:00:00Z`), end = new Date(ending);
    expect(monthlyCoverageRequirement(month, mid).end).toEqual(end);
    expect(hasSufficientMonthlyCoverage(month, mid, mid)).toBe(true);
    expect(hasSufficientMonthlyCoverage(month, mid, new Date(end.getTime() - 1))).toBe(true);
    expect(hasSufficientMonthlyCoverage(month, mid, end)).toBe(false);
    expect(hasSufficientMonthlyCoverage(month, new Date(end.getTime() - 1), end)).toBe(false);
    expect(hasSufficientMonthlyCoverage(month, end, end)).toBe(true);
    expect(hasSufficientMonthlyCoverage(month, end, new Date(end.getTime() + 1))).toBe(true);
    expect(hasSufficientMonthlyCoverage(month, end, mid)).toBe(false);
  });
});
