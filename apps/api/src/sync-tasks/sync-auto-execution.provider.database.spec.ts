import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { createServer, Server } from 'http';
import path from 'path';
import { PrismaClient, SyncExecutionErrorCategory } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AirwallexClient } from './airwallex/airwallex-client';
import { providerErrorCategory } from './provider-request-error';
import { SyncAutoExecutionService } from './sync-auto-execution.service';

const providerDescribe = process.env.TASK58_PROVIDER_TESTS === '1' ? describe : describe.skip;

providerDescribe('sync auto execution with controlled local provider', () => {
  const baseUrl = process.env.DATABASE_URL!;
  const schema = `task58_provider_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  const prisma = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  const oldEnv = { ...process.env };
  let server: Server;
  let providerUrl: string;
  let mode: 'ok' | '429' | '500' | '401' | 'timeout' = 'ok';
  let transactionCalls = 0;
  const requestUrls: string[] = [];

  beforeAll(async () => {
    process.env.SYNC_AUTO_EXECUTION_ENABLED = 'true';
    process.env.SYNC_AUTO_EXECUTION_BATCH_SIZE = '1';
    process.env.SYNC_AUTO_EXECUTION_RETRY_BASE_SECONDS = '1';
    const command = process.platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm db:migrate'] } : { file: 'pnpm', args: ['db:migrate'] };
    execFileSync(command.file, command.args, { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' });
    await prisma.$connect();
    await prisma.cardProviderCredential.create({ data: { provider: 'airwallex', encryptedPayload: 'controlled-test-only', status: 'active' } });
    server = createServer((request, response) => {
      requestUrls.push(request.url ?? '/');
      if (request.url?.startsWith('/api/v1/authentication/login')) {
        if (mode === '401') { response.writeHead(401).end(); return; }
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ token: 'local-test-token' })); return;
      }
      if (request.url?.startsWith('/api/v1/issuing/transactions')) {
        transactionCalls++;
        if (mode === '429') { response.writeHead(429).end(); return; }
        if (mode === '500') { response.writeHead(500).end(); return; }
        if (mode === 'timeout') { setTimeout(() => { if (!response.destroyed) response.end('{}'); }, 31_000); return; }
        const page = new URL(request.url, 'http://localhost').searchParams.get('page_num');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(page === '1' ? { items: [], total_count: 201 } : { items: [], total_count: 201 }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    providerUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    Object.keys(process.env).forEach((key) => { if (!(key in oldEnv)) delete process.env[key]; }); Object.assign(process.env, oldEnv);
    await prisma.$disconnect();
    const cleanup = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await cleanup.$disconnect();
  });

  function service() {
    const client = new AirwallexClient();
    const adapter = {
      adapterKey: 'card_spend.airwallex.controlled',
      async execute(context: { credential: { payload?: unknown }; settlementMonth: Date }) {
        try {
          let page = 1;
          while (true) {
            const response = await client.listCardTransactions({ credential: context.credential.payload as never, from: context.settlementMonth, to: new Date(context.settlementMonth.getTime() + 86400000), page, pageSize: 200 });
            if (!response.hasMore) break;
            page++;
          }
          return { status: 'completed' as const, successCount: 0, failedCount: 0, message: 'controlled provider completed', errorMessage: null, resultPayload: { controlledProvider: true } };
        } catch (error) {
          const category = providerErrorCategory(error);
          return { status: 'failed' as const, successCount: 0, failedCount: 1, message: null, errorMessage: error instanceof Error ? error.message : 'provider failed', resultPayload: { controlledProvider: true }, errorCategory: category };
        }
      },
    };
    return new SyncAutoExecutionService(prisma as never, new AuditService(prisma as never), { resolve: () => adapter } as never,
      { getCardProviderCredentialPayload: async () => ({ credentialId: 'local', maskedPayload: {}, payload: { clientId: 'local-client', apiKey: 'local-key', baseUrl: providerUrl } }) } as never);
  }

  async function run(scenario: typeof mode, month: string) {
    mode = scenario; transactionCalls = 0;
    const row = await prisma.syncTask.create({ data: { sourceType: 'card_spend', taskType: 'airwallex_card', platform: 'airwallex', provider: 'airwallex', settlementMonth: new Date(`${month}-01T00:00:00Z`), status: 'pending', triggerType: 'scheduled', planningKey: `provider:${scenario}:${month}` } });
    await service().poll();
    return prisma.syncTask.findUniqueOrThrow({ where: { id: row.id } });
  }

  it('completes a paginated 200 response and calls the provider once per page', async () => {
    const row = await run('ok', '2043-01');
    expect(row.status).toBe('completed'); expect(transactionCalls).toBe(2);
  });
  it.each([['429', SyncExecutionErrorCategory.RATE_LIMITED], ['500', SyncExecutionErrorCategory.PROVIDER_5XX]] as const)('schedules a finite retry for %s', async (scenario, category) => {
    const row = await run(scenario, scenario === '429' ? '2043-02' : '2043-03');
    expect(row).toMatchObject({ status: 'retry_wait', attemptCount: 1, lastErrorCategory: category }); expect(row.nextAttemptAt).not.toBeNull();
    await prisma.syncTask.update({ where: { id: row.id }, data: { nextAttemptAt: new Date('2099-01-01T00:00:00Z') } });
  });
  it('retries a prior 429 task once due and completes on 200', async () => {
    mode = 'ok'; transactionCalls = 0;
    const row = await prisma.syncTask.update({ where: { planningKey: 'provider:429:2043-02' }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await service().poll();
    expect(await prisma.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'completed', attemptCount: 2, lastErrorCategory: null });
    expect(transactionCalls).toBe(2);
  });
  it('two workers share one lease and do not duplicate provider calls', async () => {
    mode = 'ok'; transactionCalls = 0;
    const row = await prisma.syncTask.create({ data: { sourceType: 'card_spend', taskType: 'airwallex_card', platform: 'airwallex', provider: 'airwallex', settlementMonth: new Date('2043-06-01T00:00:00Z'), status: 'pending', triggerType: 'scheduled', planningKey: 'provider:double-worker:2043-06' } });
    await Promise.all([service().poll(), service().poll()]);
    expect(await prisma.syncTask.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'completed', attemptCount: 1 });
    expect(transactionCalls).toBe(2);
  });
  it('fails 401 immediately without retry', async () => {
    const row = await run('401', '2043-04');
    expect(row).toMatchObject({ status: 'failed', attemptCount: 1, lastErrorCategory: 'CREDENTIAL_INVALID', nextAttemptAt: null });
  });
  it('classifies a real aborted local HTTP request as timeout and schedules retry', async () => {
    const row = await run('timeout', '2043-05');
    expect(row).toMatchObject({ status: 'retry_wait', attemptCount: 1, lastErrorCategory: 'TIMEOUT' }); expect(transactionCalls).toBe(1);
  }, 40_000);
  it('stores no credential material in task or audit summaries', async () => {
    const serialized = JSON.stringify([await prisma.syncTask.findMany(), await prisma.auditLog.findMany()]);
    expect(serialized).not.toMatch(/local-client|local-key|local-test-token|authorization/i);
    expect(requestUrls.join('\n')).not.toMatch(/everflow|cake|airwallex\.com|photonpay/i);
  });
});

function withSchema(url: string, schema: string) { const parsed = new URL(url); parsed.searchParams.set('schema', schema); return parsed.toString(); }
