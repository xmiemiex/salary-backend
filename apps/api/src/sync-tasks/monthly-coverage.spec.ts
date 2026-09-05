import { monthlyCoverage, readMonthlyCoverage } from './monthly-coverage';
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
