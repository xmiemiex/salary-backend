import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiClient } from '../src/lib/api-client';
import { clearSession, getStoredToken, saveSession } from '../src/lib/auth-storage';
import { logoutAndClear } from '../src/lib/auth-flow';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

async function main() {
  const sessionStorage = new MemoryStorage();
  const localStorage = new MemoryStorage();
  Object.assign(globalThis, { window: { sessionStorage, localStorage } });
  saveSession({ token: 'secret-token', actor: { userId: 'u', roleCode: 'admin', permissions: [] } });
  assert.equal(getStoredToken(), 'secret-token');
  assert.equal(localStorage.length, 0);
  clearSession();
  assert.equal(getStoredToken(), null);

  saveSession({ token: 'secret-token', actor: { userId: 'u', roleCode: 'admin', permissions: [] } });
  await assert.rejects(logoutAndClear(async () => { throw new Error('offline'); }, clearSession));
  assert.equal(getStoredToken(), null, 'logout failure must still clear session storage');

  const originalFetch = globalThis.fetch;
  try {
    let requestUrl = '';
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      assert.deepEqual(JSON.parse(String(init?.body)), { username: 'admin', password: 'password-1234' });
      assert.equal(new Headers(init?.headers).get('Authorization'), null);
      return new Response(JSON.stringify({ token: 'opaque', expiresAt: '2026-06-22T00:00:00.000Z', actor: { userId: 'u', roleCode: 'admin', permissions: [] } }), { status: 200 });
    };
    await new ApiClient('http://api.test').login('admin', 'password-1234');
    assert.equal(requestUrl, 'http://api.test/auth/login');
    assert.equal(requestUrl.includes('password-1234'), false, 'password must not enter URL');
  } finally { globalThis.fetch = originalFetch; }

  const page = readFileSync(new URL('../src/pages/LoginPage.tsx', import.meta.url), 'utf8');
  assert.equal(page.includes('Dev Token'), false);
  assert.equal(page.includes('Admin User ID'), false);
  assert.equal(page.includes('<Input.Password'), true);
  console.log('auth-flow tests passed');
}

void main();
