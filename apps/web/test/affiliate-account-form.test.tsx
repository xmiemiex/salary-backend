import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/affiliate-accounts',
});
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
Object.defineProperty(windowObject, 'matchMedia', {
  value: () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }),
  configurable: true,
});
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, configurable: true });

async function run() {
  const React = await import('react');
  const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');
  const userEvent = (await import('@testing-library/user-event')).default;
  const { ConfigProvider } = await import('antd');
  const { BaseDataPage, AFFILIATE_PLATFORM_OPTIONS } = await import('../src/pages/BaseDataPages');
  const { apiClient } = await import('../src/lib/api-client');

  const calls: Array<{ path: string; method: string; body?: string }> = [];
  let postAttempts = 0;
  let rows = [
    {
      id: 'account-1',
      platform: 'everflow',
      accountCode: 'existing-code',
      accountName: null,
      status: 'active',
      defaultEmployeeId: 'legacy-must-not-render',
    },
  ];
  const originalRequest = apiClient.request.bind(apiClient);
  apiClient.request = (async (path: string, options: RequestInit = {}) => {
    calls.push({ path, method: options.method ?? 'GET', body: typeof options.body === 'string' ? options.body : undefined });
    if (path === '/affiliate-accounts') {
      if ((options.method ?? 'GET') === 'POST') {
        postAttempts += 1;
        if (postAttempts === 1) throw new Error('simulated create failure');
        return { id: 'created', ...JSON.parse(String(options.body)) };
      }
      return rows;
    }
    if (path === '/affiliate-accounts/account-1') return { ...rows[0], ...JSON.parse(String(options.body)) };
    throw new Error(`Unexpected request ${path}`);
  }) as typeof apiClient.request;

  try {
    assert.deepEqual(AFFILIATE_PLATFORM_OPTIONS, [
      { label: 'CAKE', value: 'cake' },
      { label: 'Everflow', value: 'everflow' },
    ]);
    const user = userEvent.setup({ document: windowObject.document });
    render(
      React.createElement(
        ConfigProvider,
        { theme: { token: { motion: false } } },
        React.createElement(BaseDataPage, { path: '/affiliate-accounts' }),
      ),
      { container: windowObject.document.getElementById('root')! },
    );
    await screen.findByText('existing-code');
    assert.equal(screen.queryByText('默认员工 ID'), null);
    assert.equal(screen.queryByText('legacy-must-not-render'), null);

    await user.click(screen.getByRole('button', { name: /新\s*增/ }));
    let dialog = await screen.findByRole('dialog');
    assert.equal(within(dialog).getAllByRole('combobox').length, 2, 'platform and status must both be Select controls');
    assert.equal(within(dialog).queryByText('默认员工 ID'), null);

    await user.click(within(dialog).getByRole('button', { name: /提\s*交/ }));
    assert.ok(await within(dialog).findByText('请填写Affiliate ID'));
    const affiliateIdInput = within(dialog).getByLabelText('Affiliate ID') as HTMLInputElement;
    fireEvent.input(affiliateIdInput, { target: { value: '329' } });
    assert.equal(affiliateIdInput.value, '329');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!within(dialog).queryByText('请填写Affiliate ID'), 'required error must clear after a valid input event');
    await user.click(within(dialog).getByRole('button', { name: /提\s*交/ }));
    await waitFor(() => assert.equal(calls.filter((call) => call.method === 'POST').length, 1));
    fireEvent.input(affiliateIdInput, { target: { value: '329-retry' } });
    fireEvent.input(affiliateIdInput, { target: { value: '329' } });
    await waitFor(() => assert.equal(within(dialog).getByRole('button', { name: /提\s*交/ }).hasAttribute('disabled'), false));
    await user.click(within(dialog).getByRole('button', { name: /提\s*交/ }));
    await waitFor(() => assert.equal(calls.filter((call) => call.method === 'POST').length, 2));
    const createCall = calls.filter((call) => call.method === 'POST').at(-1)!;
    assert.deepEqual(JSON.parse(createCall.body ?? '{}'), {
      platform: 'cake',
      accountCode: '329',
      status: 'active',
    });

    await user.click(screen.getByRole('button', { name: /新\s*增/ }));
    dialog = await screen.findByRole('dialog');
    assert.equal(within(dialog).queryByText('请填写Affiliate ID'), null, 'closed/reopened form must not retain validation errors');
    const reopenedInput = within(dialog).getByLabelText('Affiliate ID') as HTMLInputElement;
    fireEvent.change(reopenedInput, { target: { value: 'autofilled-329' } });
    assert.equal(reopenedInput.value, 'autofilled-329');
    await user.clear(reopenedInput);
    await user.click(reopenedInput);
    await user.paste('pasted-329');
    assert.equal(reopenedInput.value, 'pasted-329');
    await user.click(within(dialog).getByRole('button', { name: /取\s*消/ }));

    rows = rows.slice();
    await user.click(screen.getByRole('button', { name: /编\s*辑/ }));
    dialog = await screen.findByRole('dialog');
    await waitFor(() => assert.equal((within(dialog).getByLabelText('账号编码') as HTMLInputElement).value, 'existing-code'));
    assert.equal((within(dialog).getByLabelText('联盟账号名称') as HTMLInputElement).value, '');
  } finally {
    apiClient.request = originalRequest;
    cleanup();
    dom.window.close();
  }
}

void run().then(
  () => {
    console.log('affiliate account form interaction tests passed');
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
