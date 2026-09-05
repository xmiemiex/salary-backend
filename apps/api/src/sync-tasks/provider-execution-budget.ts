import { AsyncLocalStorage } from 'node:async_hooks';
import { ProviderRequestError } from './provider-request-error';

const budget = new AsyncLocalStorage<{ signal: AbortSignal }>();
export function withProviderBudget<T>(milliseconds: number, work: () => Promise<T>) {
  return budget.run({ signal: AbortSignal.timeout(milliseconds) }, work);
}
export function providerBudgetSignal() { return budget.getStore()?.signal; }
export function assertProviderBudget() {
  if (providerBudgetSignal()?.aborted) throw new ProviderRequestError('TIMEOUT', '该来源本次刷新已到执行期限，将按有限重试策略处理。');
}
