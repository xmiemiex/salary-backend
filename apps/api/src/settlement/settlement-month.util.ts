import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../common/app-error';

const GMT_PLUS_8_OFFSET_MS = 8 * 60 * 60 * 1000;

export function getCurrentSettlementMonth(now = new Date()): Date {
  if (Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date.');
  const gmt8Time = new Date(now.getTime() + GMT_PLUS_8_OFFSET_MS);
  return new Date(Date.UTC(gmt8Time.getUTCFullYear(), gmt8Time.getUTCMonth(), 1));
}

/**
 * Returns the database month marker for card_spend_events.settlement_month.
 *
 * The month is decided by the virtual card transaction time in GMT+8, and the
 * returned Date is always the first day of that month at 00:00:00.000 UTC.
 * settled_at must not be used for this attribution.
 */
export function getSettlementMonthFromTransactionAt(transactionAt: Date): Date {
  if (Number.isNaN(transactionAt.getTime())) {
    throw new TypeError('transactionAt must be a valid Date.');
  }

  const gmt8Time = new Date(transactionAt.getTime() + GMT_PLUS_8_OFFSET_MS);

  return new Date(Date.UTC(gmt8Time.getUTCFullYear(), gmt8Time.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function parseSettlementMonthParam(month: string): Date {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'month must use YYYY-MM format.');
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'month must use YYYY-MM format.');
  }

  return new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
}

export function formatSettlementMonth(month: Date): string {
  return month.toISOString().slice(0, 7);
}

export function nextSettlementMonth(month: Date): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}
