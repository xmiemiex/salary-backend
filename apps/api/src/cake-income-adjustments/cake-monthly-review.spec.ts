import { Prisma } from '@prisma/client';
import { cakeBaseFingerprint, summarizeCakeMonthlyReview } from './cake-monthly-review';
import { buildCakeAdjustmentMetadata } from './cake-income-adjustment.utils';
import { CakeIncomeAdjustmentsService } from './cake-income-adjustments.service';

const base = (value: string, sub = 'a') => ({ subField: 'sub1', subValue: sub, incomeUsd: new Prisma.Decimal(value) });
const confirmation = (rows = [base('100')]) => ({ baseFingerprint: cakeBaseFingerprint(rows), confirmedAt: new Date('2026-09-07'), confirmedBy: 'reviewer' });
const adjustment = (status: string) => ({ ...base('10'), status, rawData: buildCakeAdjustmentMetadata({ baseRevenueUsd: new Prisma.Decimal(100), actualRevenueUsd: new Prisma.Decimal(110), adjustmentUsd: new Prisma.Decimal(10), reason: 'isolated test' }) as unknown as Prisma.JsonValue });

describe('CAKE manual monthly review evidence', () => {
  it('defaults to unreviewed; ordinary drafts and disabled adjustments prove nothing', () => {
    for (const rows of [[], [adjustment('draft')], [adjustment('disabled')]]) expect(summarizeCakeMonthlyReview([base('100')], rows, null).status).toBe('unreviewed');
  });
  it('represents zero-difference confirmation without creating income', () => {
    expect(summarizeCakeMonthlyReview([base('100')], [], confirmation())).toMatchObject({ status: 'confirmed_no_adjustment', confirmedAdjustmentCount: 0, basis: 'account_month_native_fingerprint' });
    expect(summarizeCakeMonthlyReview([], [], confirmation([])).status).toBe('confirmed_no_adjustment');
  });
  it('retains equivalent refreshes, but detects SUB redistribution even when total is unchanged', () => {
    expect(cakeBaseFingerprint([base('20'), base('80'), base('3', 'b')])).toBe(cakeBaseFingerprint([base('3.00', 'b'), base('100.000')]));
    expect(summarizeCakeMonthlyReview([base('101')], [], confirmation()).status).toBe('needs_review');
    expect(summarizeCakeMonthlyReview([base('99'), base('1', 'new-sub')], [], confirmation()).status).toBe('needs_review');
    expect(summarizeCakeMonthlyReview([], [], confirmation()).status).toBe('needs_review');
  });
  it('accepts valid confirmed SUB adjustments as limited evidence, never a whole-account confirmation', () => {
    expect(summarizeCakeMonthlyReview([base('100')], [adjustment('confirmed')], null)).toMatchObject({ status: 'adjusted', confirmedAt: null, basis: 'confirmed_sub_adjustments', confirmedAdjustmentCount: 1 });
    expect(summarizeCakeMonthlyReview([base('101')], [adjustment('confirmed')], null).status).toBe('needs_review');
  });
  it('keeps explicit adapter-staled drafts pending review, without treating them as confirmed', () => {
    const stale = adjustment('draft'); stale.rawData = { ...(stale.rawData as Prisma.JsonObject), stale: true };
    expect(summarizeCakeMonthlyReview([base('101')], [stale], null)).toMatchObject({ status: 'needs_review', confirmedAdjustmentCount: 0, staleAdjustmentCount: 1 });
    expect(summarizeCakeMonthlyReview([base('101')], [{ ...stale, status: 'disabled' }], null).status).toBe('unreviewed');
  });
  it('does not accept malformed confirmed adjustment bases', () => {
    expect(summarizeCakeMonthlyReview([base('100')], [{ ...adjustment('confirmed'), rawData: null }], null).status).toBe('needs_review');
  });
  it('requires the same elevated permission as CAKE adjustments for confirm and cancel', async () => {
    const service = new CakeIncomeAdjustmentsService({} as never, {} as never, {} as never);
    for (const actor of [{ userId: 'x', roleCode: 'operator', permissions: ['income.import'] }, { userId: 'x', roleCode: 'super_admin', permissions: [] }]) {
      await expect(service.confirmMonthlyReview({ affiliateAccountId: 'x', settlementMonth: '2026-07' }, actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(service.cancelMonthlyReview({ affiliateAccountId: 'x', settlementMonth: '2026-07' }, actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
});
