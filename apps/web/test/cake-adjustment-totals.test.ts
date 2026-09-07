import assert from 'node:assert/strict';
import { cakePageTotals, exactUsd, sumUsd } from '../src/pages/cake-adjustment-totals';
assert.equal(sumUsd(['0.1', '0.2', '-0.3']), '0.000000');
assert.equal(sumUsd(['999999999999.999999', '0.000001']), '1000000000000.000000');
assert.equal(exactUsd('999999999999.999999'), '999,999,999,999.999999');
assert.equal(sumUsd([null, undefined]), null);
assert.equal(exactUsd(null), '—');
assert.deepEqual(cakePageTotals([
  { baseRevenueUsd: '0.1', previousBaseRevenueUsd: '0.09', actualRevenueUsd: null, adjustmentUsd: '-0.01', previewRevenueUsd: '0.09' },
  { baseRevenueUsd: '0.2', previousBaseRevenueUsd: null, actualRevenueUsd: '0.3', adjustmentUsd: '0.1', previewRevenueUsd: '0.3' },
]), ['0.300000', '0.290000', '0.300000', '0.090000', '0.390000']);
assert.deepEqual(cakePageTotals([]), ['0', '0', null, '0', '0']);
console.log('Exact CAKE current-page totals passed');
