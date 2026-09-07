// Amounts are stored with six decimal places. Sum and format integer micro-USD
// so a large total does not lose cents through JavaScript floating-point addition.
export function usdUnits(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(value)) throw new Error('金额格式无效');
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))) * (negative ? -1n : 1n);
}
export function unitsToUsd(value: bigint): string {
  const negative = value < 0n, absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / 1000000n}.${String(absolute % 1000000n).padStart(6, '0')}`;
}
export function sumUsd(values: (string | null | undefined)[]): string | null {
  const present = values.filter((value): value is string => value != null);
  return present.length ? unitsToUsd(present.reduce((sum, value) => sum + usdUnits(value), 0n)) : null;
}
export function exactUsd(value: string | null | undefined): string {
  if (value == null) return '—';
  const [whole, fraction] = unitsToUsd(usdUnits(value)).split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + fraction.replace(/0+$/, '').padEnd(2, '0');
}
export type CakeAmountRow = { baseRevenueUsd: string; previousBaseRevenueUsd: string | null; actualRevenueUsd: string | null; adjustmentUsd: string; previewRevenueUsd: string };
export function cakePageTotals(rows: CakeAmountRow[]) {
  return [sumUsd(rows.map(r => r.baseRevenueUsd)) ?? '0', sumUsd(rows.map(r => r.previousBaseRevenueUsd ?? r.baseRevenueUsd)) ?? '0', sumUsd(rows.map(r => r.actualRevenueUsd)), sumUsd(rows.map(r => r.adjustmentUsd)) ?? '0', sumUsd(rows.map(r => r.previewRevenueUsd)) ?? '0'];
}
