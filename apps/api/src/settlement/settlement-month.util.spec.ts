import { ERROR_CODES } from '@salary/shared';
import { parseSettlementMonthParam, getSettlementMonthFromTransactionAt } from './settlement-month.util';

describe('getSettlementMonthFromTransactionAt', () => {
  it('attributes UTC 2026-01-31T17:00:00.000Z to 2026-02 in GMT+8', () => {
    const result = getSettlementMonthFromTransactionAt(new Date('2026-01-31T17:00:00.000Z'));

    expect(result.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('attributes UTC 2026-01-31T15:59:59.000Z to 2026-01 in GMT+8', () => {
    const result = getSettlementMonthFromTransactionAt(new Date('2026-01-31T15:59:59.000Z'));

    expect(result.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('attributes ordinary mid-month dates to the same GMT+8 month', () => {
    const result = getSettlementMonthFromTransactionAt(new Date('2026-05-10T03:00:00.000Z'));

    expect(result.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('rejects invalid dates explicitly', () => {
    expect(() => getSettlementMonthFromTransactionAt(new Date('invalid'))).toThrow(TypeError);
  });
});

describe('parseSettlementMonthParam', () => {
  it('parses YYYY-MM as first day of month at UTC midnight', () => {
    const result = parseSettlementMonthParam('2026-05');

    expect(result.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('rejects invalid month format', () => {
    expect(() => parseSettlementMonthParam('2026-5')).toThrow(
      expect.objectContaining({ code: ERROR_CODES.VALIDATION_ERROR }),
    );
    expect(() => parseSettlementMonthParam('2026-13')).toThrow(
      expect.objectContaining({ code: ERROR_CODES.VALIDATION_ERROR }),
    );
  });
});
