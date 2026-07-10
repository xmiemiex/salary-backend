import assert from 'node:assert/strict';
import { ApiClient, ApiError } from '../src/lib/api-client';

async function main() {
  const originalFetch = globalThis.fetch;
  let unauthorizedCalls = 0;
  let permissionDeniedCalls = 0;
  const client = new ApiClient('http://api.test');
  client.configure({
    getToken: () => 'test-token',
    onUnauthorized: () => { unauthorizedCalls += 1; },
    onPermissionDenied: () => { permissionDeniedCalls += 1; },
  });

  try {
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'PERMISSION_DENIED']] as const) {
    globalThis.fetch = async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token');
      return new Response(JSON.stringify({ success: false, error: { code, message: `${status} error`, details: { field: 'x' } } }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    await assert.rejects(client.download('/audit-logs/export'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.message, `${status} error`);
      return true;
    });
  }
  assert.equal(unauthorizedCalls, 1);
  assert.equal(permissionDeniedCalls, 1);

  let blobCalls = 0;
  let textCalls = 0;
  let jsonCalls = 0;
  const csvBlob = new Blob(['id\r\n1'], { type: 'text/csv' });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit.csv"' }),
    blob: async () => { blobCalls += 1; return csvBlob; },
    text: async () => { textCalls += 1; throw new Error('CSV must not be read as text/JSON'); },
    json: async () => { jsonCalls += 1; throw new Error('CSV must not be parsed as JSON'); },
  } as Response);
  const downloaded = await client.download('/audit-logs/export?settlementMonth=2026-06');
  assert.equal(downloaded.blob, csvBlob);
  assert.equal(downloaded.contentType, 'text/csv; charset=utf-8');
  assert.equal(downloaded.contentDisposition, 'attachment; filename="audit.csv"');
  assert.equal(blobCalls, 1);
  assert.equal(textCalls, 0);
  assert.equal(jsonCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('api-client tests passed');
}

void main();
