import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/data-sync' });
const windowObject = dom.window as unknown as Window & typeof globalThis;
Object.assign(globalThis, {
  window: windowObject,
  document: windowObject.document,
  HTMLElement: windowObject.HTMLElement,
  SVGElement: windowObject.SVGElement,
  Element: windowObject.Element,
  Node: windowObject.Node,
  MutationObserver: windowObject.MutationObserver,
  getComputedStyle: (element: Element) => windowObject.getComputedStyle(element),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, 'navigator', { value: windowObject.navigator, configurable: true });
Object.defineProperty(globalThis, 'ShadowRoot', { value: windowObject.ShadowRoot, configurable: true });
Object.defineProperty(windowObject, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }), configurable: true });
Object.defineProperty(windowObject, 'scrollTo', { value: () => undefined, configurable: true });
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, configurable: true });

async function run() {
const React = await import('react');
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const { DataSyncPage } = await import('../src/pages/DataSyncPage');
const { ConfigProvider } = await import('antd');
const { apiClient, ApiError } = await import('../src/lib/api-client');
const { saveSession, getStoredToken } = await import('../src/lib/auth-storage');

type RequestCall = { path: string; method: string; body?: string };
const calls: RequestCall[] = [];
let previewMode: 'open' | 'locked' = 'open';
let generateFailure: ApiError | null = null;

const candidates = () => previewMode === 'locked' ? [
  candidate('affiliate_income', 'affiliate_income', 'Everflow locked', 'everflow', null, ['MONTH_LOCKED']),
  candidate('affiliate_income', 'affiliate_income', 'CAKE locked', 'cake', null, ['MONTH_LOCKED', 'CREDENTIAL_MISSING']),
  candidate('card_spend', 'airwallex_card', null, 'airwallex', 'airwallex', ['MONTH_LOCKED']),
  candidate('card_spend', 'photonpay_card', null, 'photonpay', 'photonpay', ['MONTH_LOCKED']),
] : [
  { ...candidate('affiliate_income', 'affiliate_income', 'Everflow Account', 'everflow', null, []), apiKey: 'DO_NOT_RENDER', secret: 'DO_NOT_RENDER', token: 'DO_NOT_RENDER', clientId: 'DO_NOT_RENDER', merchantId: 'DO_NOT_RENDER', encryptedPayload: 'DO_NOT_RENDER' },
  candidate('affiliate_income', 'affiliate_income', 'CAKE Account', 'cake', null, ['CREDENTIAL_MISSING']),
  { ...candidate('card_spend', 'airwallex_card', null, 'airwallex', 'airwallex', ['TASK_ALREADY_EXISTS']), existingTaskId: 'existing-airwallex' },
  candidate('card_spend', 'photonpay_card', null, 'photonpay', 'photonpay', []),
];

function candidate(sourceType: string, taskType: string, affiliateAccountName: string | null, platform: string, provider: string | null, blockerCodes: string[]) {
  return { sourceType, taskType, settlementMonth: previewMode === 'locked' ? '2038-07' : '2038-06', affiliateAccountId: affiliateAccountName ? `${platform}-id` : null, affiliateAccountName, platform, provider, credentialConfigured: !blockerCodes.includes('CREDENTIAL_MISSING'), existingTaskId: null, canCreate: blockerCodes.length === 0, blockerCodes };
}

const originalRequest = apiClient.request.bind(apiClient);
apiClient.request = (async (path: string, options: RequestInit = {}) => {
  calls.push({ path, method: options.method ?? 'GET', body: typeof options.body === 'string' ? options.body : undefined });
  if (path.startsWith('/settlements/')) return { status: previewMode === 'locked' ? 'locked' : 'draft' };
  if (path.startsWith('/affiliate-accounts')) return [];
  if (path === '/api-credentials/affiliate-accounts' || path === '/api-credentials/card-providers') return [];
  if (path.startsWith('/sync-tasks?')) return { items: [
    { taskId: 'manual-affiliate-pending', sourceType: 'affiliate_income', taskType: 'affiliate_income', platform: 'everflow', settlementMonth: '2038-06', status: 'pending', triggerType: 'manual', attemptCount: 0, executing: false, lastErrorCategory: null, nextAttemptAt: null },
    { taskId: 'scheduled-card-pending', sourceType: 'card_spend', taskType: 'airwallex_card', platform: 'airwallex', provider: 'airwallex', settlementMonth: '2038-06', status: 'pending', triggerType: 'scheduled', attemptCount: 0, executing: false, lastErrorCategory: null, nextAttemptAt: null },
    { taskId: 'running-task', sourceType: 'affiliate_income', taskType: 'affiliate_income', platform: 'everflow', settlementMonth: '2038-06', status: 'running', triggerType: 'scheduled', attemptCount: 1, executing: true, lastErrorCategory: null, nextAttemptAt: null },
    { taskId: 'retry-task', sourceType: 'card_spend', taskType: 'airwallex_card', platform: 'airwallex', provider: 'airwallex', settlementMonth: '2038-06', status: 'retry_wait', triggerType: 'scheduled', attemptCount: 2, executing: false, lastErrorCategory: 'RATE_LIMITED', nextAttemptAt: '2038-07-01T00:05:00.000Z' },
    { taskId: 'completed-task', sourceType: 'affiliate_income', taskType: 'affiliate_income', platform: 'cake', settlementMonth: '2038-06', status: 'completed', triggerType: 'scheduled', attemptCount: 1, executing: false, lastErrorCategory: null, nextAttemptAt: null },
    { taskId: 'failed-task', sourceType: 'card_spend', taskType: 'photonpay_card', platform: 'photonpay', provider: 'photonpay', settlementMonth: '2038-06', status: 'failed', triggerType: 'scheduled', attemptCount: 3, executing: false, lastErrorCategory: 'CREDENTIAL_INVALID', resultPayload: { apiKey: 'TASK_SECRET_DO_NOT_RENDER' } },
  ], total: 6, page: 1, pageSize: 20 };
  if (path.startsWith('/sync-tasks/operations')) return { items: [
    { taskId: 'operation-manual-pending', sourceType: 'affiliate_income', taskType: 'affiliate_income', platform: 'everflow', settlementMonth: '2038-06', status: 'pending', triggerType: 'manual', attemptCount: 0, maxAttempts: 3, leaseState: 'none', lastErrorCategory: null, nextAttemptAt: null },
    { taskId: 'operation-scheduled-running', sourceType: 'card_spend', taskType: 'airwallex_card', platform: 'airwallex', provider: 'airwallex', settlementMonth: '2038-06', status: 'running', triggerType: 'scheduled', attemptCount: 1, maxAttempts: 3, leaseState: 'active', lastErrorCategory: null, nextAttemptAt: null },
    { taskId: 'operation-retry-wait', sourceType: 'card_spend', taskType: 'airwallex_card', platform: 'airwallex', provider: 'airwallex', settlementMonth: '2038-06', status: 'retry_wait', triggerType: 'scheduled', attemptCount: 2, maxAttempts: 3, leaseState: 'none', lastErrorCategory: 'RATE_LIMITED', nextAttemptAt: '2038-07-01T00:05:00.000Z', lastErrorSafeMessage: 'rate limited' },
    { taskId: 'operation-completed', sourceType: 'affiliate_income', taskType: 'affiliate_income', platform: 'cake', settlementMonth: '2038-06', status: 'completed', triggerType: 'scheduled', attemptCount: 1, maxAttempts: 3, leaseState: 'none', lastErrorCategory: null, nextAttemptAt: null },
    { taskId: 'operation-failed', sourceType: 'card_spend', taskType: 'photonpay_card', platform: 'photonpay', provider: 'photonpay', settlementMonth: '2038-06', status: 'failed', triggerType: 'scheduled', attemptCount: 3, maxAttempts: 3, leaseState: 'none', lastErrorCategory: 'CREDENTIAL_INVALID', nextAttemptAt: null, lastErrorSafeMessage: 'credential invalid', resultSummary: { secret: 'TASK_SECRET_DO_NOT_RENDER', safe: 'ok' } },
  ], total: 5, page: 1, pageSize: 50 };
  if (path === '/sync-tasks/operation-failed/operation-detail') return {
    task: { taskId: 'operation-failed', sourceType: 'card_spend', taskType: 'photonpay_card', platform: 'photonpay', provider: 'photonpay', settlementMonth: '2038-06', status: 'failed', triggerType: 'scheduled', attemptCount: 3, maxAttempts: 3, leaseState: 'none', lastErrorCategory: 'CREDENTIAL_INVALID', nextAttemptAt: null, lastErrorSafeMessage: 'credential invalid', resultSummary: { safe: 'ok' } },
    retryable: false,
    suggestedAction: '检查并修复 API 凭证配置后再请求重试。',
    recentEvents: [{ id: 'audit-1', action: 'sync_task.auto.failed', result: 'failure', failureReason: 'CREDENTIAL_INVALID', errorMessage: 'credential invalid', createdAt: '2038-07-01T00:00:00.000Z', actorUserId: null, summary: { safe: 'ok' } }],
  };
  if (path === '/sync-tasks/operation-failed/request-retry') return { task: { taskId: 'operation-failed', status: 'pending' }, action: 'manual_retry_requested' };
  if (path === '/sync-tasks/operation-retry-wait/cancel') return { task: { taskId: 'operation-retry-wait', status: 'cancelled' }, action: 'cancelled' };
  if (path === '/sync-auto-execution/status') return { enabled: false, pollSeconds: 60, batchSize: 2, maxAttempts: 3, activeLeaseCount: 0, pendingEligibleCount: 2, retryWaitingCount: 1, permanentlyFailedCount: 1, lastPollAt: null, lastClaimAt: null };
  if (path.startsWith('/sync-planning/preview')) {
    const rows = candidates();
    const existingCount = rows.filter((row) => row.blockerCodes.includes('TASK_ALREADY_EXISTS')).length;
    const blockedCount = rows.filter((row) => !row.canCreate && !row.existingTaskId).length;
    return { settlementMonth: previewMode === 'locked' ? '2038-07' : '2038-06', locked: previewMode === 'locked', candidates: rows, summary: { candidateCount: 4, creatableCount: rows.filter((row) => row.canCreate).length, existingCount, blockedCount } };
  }
  if (path === '/sync-planning/generate') {
    if (generateFailure) throw generateFailure;
    return { summary: { createdCount: 2 } };
  }
  throw new Error(`Unexpected request: ${path}`);
}) as typeof apiClient.request;

async function main() {
  try {
    saveSession({ token: 'valid-session', actor: { userId: 'admin', roleCode: 'finance', permissions: ['income.import', 'manual_card_spend.manage'] } });
    const user = userEvent.setup({ document: windowObject.document });
    const page = () => React.createElement(ConfigProvider, { theme: { token: { motion: false } } }, React.createElement(DataSyncPage));
    const mounted = render(page(), { container: windowObject.document.getElementById('root')! });
    assert.ok(await screen.findByRole('region', { name: '月度任务规划' }));
    assert.match(screen.getByText(/这里只生成任务，不会立即执行同步或调用外部 API/).textContent ?? '', /pending/);

    assert.ok(await screen.findByRole('region', { name: '自动执行状态' }));
    assert.ok(screen.getByText('自动执行未启用，任务需人工执行'));
    assert.ok(await screen.findByRole('region', { name: '同步执行运行台' }));
    await screen.findByText('operation-retry-wait');
    const failedOperationRow = screen.getByText('operation-failed').closest('tr');
    assert.ok(failedOperationRow);
    assert.equal((within(failedOperationRow).getByRole('button', { name: /请求重试/ }) as HTMLButtonElement).disabled, false);
    assert.equal((within(failedOperationRow).getByRole('button', { name: /取\s*消/ }) as HTMLButtonElement).disabled, false);
    const runningOperationRow = screen.getByText('operation-scheduled-running').closest('tr');
    assert.ok(runningOperationRow);
    assert.equal((within(runningOperationRow).getByRole('button', { name: /请求重试/ }) as HTMLButtonElement).disabled, true);
    assert.equal((within(runningOperationRow).getByRole('button', { name: /取\s*消/ }) as HTMLButtonElement).disabled, true);
    const completedOperationRow = screen.getByText('operation-completed').closest('tr');
    assert.ok(completedOperationRow);
    assert.equal((within(completedOperationRow).getByRole('button', { name: /请求重试/ }) as HTMLButtonElement).disabled, true);
    assert.equal((within(completedOperationRow).getByRole('button', { name: /取\s*消/ }) as HTMLButtonElement).disabled, true);
    await user.click(within(failedOperationRow).getByRole('button', { name: /详\s*情/ }));
    await screen.findByText('同步任务处置详情');
    assert.ok(screen.getByText('credential invalid'));
    assert.ok(screen.getByText('检查并修复 API 凭证配置后再请求重试。'));
    assert.equal(screen.queryByText('TASK_SECRET_DO_NOT_RENDER'), null);
    await user.click(screen.getByLabelText('Close'));
    await user.click(within(failedOperationRow).getByRole('button', { name: /请求重试/ }));
    const retryDialog = await screen.findByRole('dialog');
    assert.match(retryDialog.textContent ?? '', /不会在页面上立即调用外部 API/);
    await user.click(within(retryDialog).getByRole('button', { name: /请求重试/ }));
    await waitFor(() => assert.ok(calls.some((call) => call.path === '/sync-tasks/operation-failed/request-retry')));
    const retryCall = calls.find((call) => call.path === '/sync-tasks/operation-failed/request-retry')!;
    assert.equal(retryCall.method, 'POST');
    assert.deepEqual(Object.keys(JSON.parse(retryCall.body ?? '{}')), ['reason']);
    const retryWaitRow = screen.getByText('operation-retry-wait').closest('tr');
    assert.ok(retryWaitRow);
    await user.click(within(retryWaitRow).getByRole('button', { name: /取\s*消/ }));
    const cancelDialog = await screen.findByRole('dialog');
    await user.click(within(cancelDialog).getByRole('button', { name: /确认取消/ }));
    await waitFor(() => assert.ok(calls.some((call) => call.path === '/sync-tasks/operation-retry-wait/cancel')));
    assert.ok((await screen.findAllByText('RATE_LIMITED')).length >= 2);
    assert.ok(screen.getAllByText('CREDENTIAL_INVALID').length >= 2);
    assert.ok(screen.getAllByText('执行中').length >= 1);
    const runningRow = screen.getByText('running-task').closest('tr');
    assert.ok(runningRow);
    assert.equal((within(runningRow).getByRole('button', { name: /执\s*行/ }) as HTMLButtonElement).disabled, true, 'running task execute button must be disabled');
    const executeButtonFor = (taskId: string) => {
      const row = screen.getByText(taskId).closest('tr');
      assert.ok(row, `${taskId} row must exist`);
      const buttons = Array.from(row.querySelectorAll('button')) as HTMLButtonElement[];
      const executeButton = buttons.find((button) => button.getAttribute('aria-label') !== 'Expand row');
      assert.ok(executeButton, `${taskId} execute button must exist`);
      return executeButton;
    };
    assert.equal(executeButtonFor('manual-affiliate-pending').disabled, false, 'manual pending affiliate task can be executed by income importer');
    assert.equal(executeButtonFor('scheduled-card-pending').disabled, false, 'scheduled pending card task can be executed by card manager');
    assert.equal(executeButtonFor('running-task').disabled, true, 'running task execute button must be disabled');
    assert.equal(executeButtonFor('retry-task').disabled, false, 'retry_wait task remains manually executable by privileged user');
    assert.equal(executeButtonFor('completed-task').disabled, true, 'completed task execute button must be disabled');
    assert.equal(executeButtonFor('failed-task').disabled, false, 'failed task follows existing manual retry path for privileged user');
    assert.equal(screen.queryByText('TASK_SECRET_DO_NOT_RENDER'), null);
    const monthInput = mounted.container.querySelector('input[type="month"]');
    assert.ok(monthInput, 'settlementMonth input must exist');
    fireEvent.change(monthInput, { target: { value: '2038-06' } });
    const previewButton = screen.getByRole('button', { name: '预览候选任务' });
    await user.click(previewButton);
    await screen.findByText('Everflow Account');
    for (const text of ['CAKE Account', 'airwallex', 'photonpay', 'CREDENTIAL_MISSING', 'TASK_ALREADY_EXISTS']) assert.ok(screen.getAllByText(text).length >= 1);
    for (const secret of ['DO_NOT_RENDER', 'apiKey', 'encryptedPayload']) assert.equal(screen.queryByText(secret), null);
    assert.ok(calls.some((call) => call.path === '/sync-planning/preview?settlementMonth=2038-06'));

    const generateButton = screen.getByRole('button', { name: '生成待执行任务' });
    assert.equal((generateButton as HTMLButtonElement).disabled, false);
    await user.click(generateButton);
    const dialog = await screen.findByRole('dialog');
    assert.match(dialog.textContent ?? '', /二次|确认生成月度待执行任务|不会立即执行同步/);
    await user.click(within(dialog).getByRole('button', { name: '生成待执行任务' }));
    await waitFor(() => assert.ok(calls.some((call) => call.path === '/sync-planning/generate')));
    const generateCall = calls.find((call) => call.path === '/sync-planning/generate')!;
    assert.equal(generateCall.method, 'POST');
    assert.deepEqual(JSON.parse(generateCall.body ?? '{}'), { settlementMonth: '2038-06' });
    await waitFor(() => assert.ok(calls.filter((call) => call.path.startsWith('/sync-planning/preview')).length >= 2));
    assert.ok(calls.filter((call) => call.path.startsWith('/sync-tasks?')).length >= 2, 'task list must refresh after generation');
    assert.equal(calls.some((call) => call.path.includes('/execute')), false);
    await waitFor(() => assert.equal(screen.queryByRole('dialog'), null));

    generateFailure = new ApiError(403, 'PERMISSION_DENIED', '权限不足');
    await user.click(screen.getByRole('button', { name: '生成待执行任务' }));
    const failedDialog = await screen.findByRole('dialog');
    await user.click(within(failedDialog).getByRole('button', { name: '生成待执行任务' }));
    await screen.findByText('权限不足');
    assert.ok(screen.getByText('Everflow Account'), 'existing preview must remain after API failure');
    assert.equal(getStoredToken(), 'valid-session', '403 must not clear session');
    await waitFor(() => assert.equal(screen.queryByRole('dialog'), null));
    generateFailure = null;

    previewMode = 'locked';
    fireEvent.change(monthInput, { target: { value: '2038-07' } });
    await user.click(previewButton);
    await screen.findByText('该结算月份已锁账，所有候选均不可创建。');
    assert.ok(screen.getAllByText('MONTH_LOCKED').length >= 1);
    assert.equal((screen.getByRole('button', { name: '生成待执行任务' }) as HTMLButtonElement).disabled, true);

    cleanup();
    windowObject.document.body.innerHTML = '<div id="root-low"></div>';
    saveSession({ token: 'low-session', actor: { userId: 'low', roleCode: 'viewer', permissions: ['salary.view_all'] } });
    render(page(), { container: windowObject.document.getElementById('root-low')! });
    await screen.findByRole('region', { name: '月度任务规划' });
    assert.equal(screen.queryByRole('button', { name: '生成待执行任务' }), null, 'generate entry must be hidden without both permissions');
    const lowPermissionTaskButtons = screen.getAllByRole('button', { name: /执\s*行/ });
    assert.ok(lowPermissionTaskButtons.length >= 1);
    assert.ok(lowPermissionTaskButtons.every((button) => (button as HTMLButtonElement).disabled), 'execute buttons must be disabled without task execution permission');

    await screen.findByText('operation-failed');
    const lowOperationButtons = [
      ...screen.getAllByRole('button', { name: /请求重试/ }),
      ...screen.getAllByRole('button', { name: /取\s*消/ }),
    ];
    assert.ok(lowOperationButtons.length >= 1);
    assert.ok(lowOperationButtons.every((button) => (button as HTMLButtonElement).disabled), 'operation buttons must be disabled without task execution permission');

    cleanup();
    apiClient.request = originalRequest;
    let unauthorized = 0;
    let forbidden = 0;
    apiClient.configure({ getToken: () => 'session', onUnauthorized: () => { unauthorized++; }, onPermissionDenied: () => { forbidden++; } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ success: false, error: { code: 'PERMISSION_DENIED', message: 'forbidden' } }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(apiClient.request('/sync-planning/generate', { method: 'POST' }));
    assert.equal(forbidden, 1); assert.equal(unauthorized, 0);
    globalThis.fetch = async () => new Response(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'expired' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(apiClient.request('/sync-planning/preview'));
    assert.equal(unauthorized, 1, '401 must use unified logout flow');
    globalThis.fetch = originalFetch;
    console.log('data sync planning page interaction tests passed');
  } finally {
    apiClient.request = originalRequest;
    cleanup();
    dom.window.close();
  }
}

void main();
}

void run();
