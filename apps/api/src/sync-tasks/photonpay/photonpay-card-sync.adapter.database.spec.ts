import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import {
  PrismaClient,
  Provider,
  ProviderCardMatchSource,
  ProviderCardMatchStatus,
  SyncTaskPlatform,
  SyncTaskSourceType,
  SyncTaskType,
} from '@prisma/client';
import { PhotonPayCardSyncAdapter } from './photonpay-card-sync.adapter';

const databaseDescribe = process.env.TASK102_DATABASE_TESTS === '1' ? describe : describe.skip;

databaseDescribe('task102 PhotonPay USD debit accounting on isolated PostgreSQL', () => {
  const baseUrl = process.env.DATABASE_URL!;
  const schema = `task102_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  const prisma = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  const client = { listCardTransactions: jest.fn() };
  const unmatched = {
    resolveAfterSuccessfulImport: jest.fn().mockResolvedValue(undefined),
    recordUnmatchedEvent: jest.fn().mockResolvedValue(undefined),
  };
  const inventory = {
    syncProviderWithPayload: jest.fn().mockResolvedValue({ provider: Provider.photonpay, status: 'completed' }),
    resolveSpendOwner: jest.fn(),
    markTransactionSync: jest.fn().mockResolvedValue(undefined),
    markUntouchedTransactionSync: jest.fn().mockResolvedValue(undefined),
  };
  let employeeId: string;
  let adapter: PhotonPayCardSyncAdapter;

  beforeAll(async () => {
    const command = process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm db:migrate'] }
      : { file: 'pnpm', args: ['db:migrate'] };
    execFileSync(command.file, command.args, {
      cwd: root,
      env: { ...process.env, DATABASE_URL: schemaUrl },
      stdio: 'pipe',
    });
    await prisma.$connect();
    const employee = await prisma.employee.create({
      data: { employeeCode: 'TASK102', name: 'Task 102', email: 'task102@example.test', status: 'active' },
    });
    employeeId = employee.id;
    inventory.resolveSpendOwner.mockResolvedValue({ ok: true, employeeId });
    adapter = new PhotonPayCardSyncAdapter(prisma as never, client as never, unmatched as never, inventory as never);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    const cleanup = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.$disconnect();
  });

  it('persists original EUR audit values and provider USD debit, then skips the identical rerun', async () => {
    client.listCardTransactions.mockResolvedValue({ transactions: [transaction()], hasMore: false });

    const first = await adapter.execute(verificationContext());
    const second = await adapter.execute(verificationContext());

    expect(first).toMatchObject({ status: 'completed', successCount: 1, failedCount: 0 });
    expect(first.resultPayload).toMatchObject({
      createdCount: 1,
      settledConvertedToUsdCount: 1,
      providerUsdDebitAmountTotal: '9.74',
    });
    expect(second).toMatchObject({ status: 'completed', successCount: 1, failedCount: 0 });
    expect(second.resultPayload).toMatchObject({ createdCount: 0, updatedCount: 0, skippedCount: 1 });
    const event = await prisma.cardSpendEvent.findUniqueOrThrow({
      where: { provider_externalEventId: { provider: Provider.photonpay, externalEventId: 'task102-eur-1' } },
    });
    expect(event.amount?.toString()).toBe('8.25');
    expect(event.currency).toBe('EUR');
    expect(event.spendUsd.toString()).toBe('9.74');
    expect(await prisma.cardSpendEvent.count({ where: { externalEventId: 'task102-eur-1' } })).toBe(1);
  });

  it('fails closed and preserves the stored value when the same external ID reports a different USD debit', async () => {
    client.listCardTransactions.mockResolvedValue({
      transactions: [{ ...transaction(), txnPrincipalChangeSettledAmount: '-10.00' }],
      hasMore: false,
    });

    const result = await adapter.execute(verificationContext());

    expect(result).toMatchObject({ status: 'failed', successCount: 0, failedCount: 1 });
    expect(result.resultPayload).toMatchObject({ amountMismatchCount: 1, updatedCount: 0 });
    const event = await prisma.cardSpendEvent.findUniqueOrThrow({
      where: { provider_externalEventId: { provider: Provider.photonpay, externalEventId: 'task102-eur-1' } },
    });
    expect(event.spendUsd.toString()).toBe('9.74');
    expect(unmatched.recordUnmatchedEvent).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'PROVIDER_USD_DEBIT_AMOUNT_MISMATCH',
    }));
  });

  it('previews and imports only the exact 60 alias cards, excluding the admin test card', async () => {
    await prisma.providerCard.createMany({
      data: [
        ...Array.from({ length: 60 }, (_, index) => ({
          provider: Provider.photonpay,
          cardId: `task102-alias-${index + 1}`,
          employeeId,
          matchStatus: ProviderCardMatchStatus.matched,
          matchSource: ProviderCardMatchSource.provider_email_alias,
          providerStatus: 'ACTIVE',
        })),
        {
          provider: Provider.photonpay,
          cardId: 'task102-admin-test',
          matchStatus: ProviderCardMatchStatus.excluded,
          providerStatus: 'ACTIVE',
        },
      ],
    });
    client.listCardTransactions.mockResolvedValue({
      transactions: [
        { ...transaction(), transactionId: 'task102-history-target', cardId: 'task102-alias-1', txnDate: '2026-07-02T00:00:00.000Z' },
        { ...transaction(), transactionId: 'task102-history-primary', cardId: 'task102-primary', txnDate: '2026-07-02T00:00:00.000Z' },
        { ...transaction(), transactionId: 'task102-history-excluded', cardId: 'task102-admin-test', txnDate: '2026-07-02T00:00:00.000Z' },
      ],
      hasMore: false,
    });

    const preview = await adapter.execute(historicalContext(true));
    const first = await adapter.execute(historicalContext(false));
    const second = await adapter.execute(historicalContext(false));

    expect(preview).toMatchObject({ status: 'completed', successCount: 1, failedCount: 0 });
    expect(preview.resultPayload).toMatchObject({
      previewExpectedCreatedCount: 1,
      excludedCardTransactionCount: 1,
      nonTargetCardTransactionCount: 1,
    });
    expect(first.resultPayload).toMatchObject({ createdCount: 1, excludedCardTransactionCount: 1, nonTargetCardTransactionCount: 1 });
    expect(second.resultPayload).toMatchObject({ createdCount: 0, skippedCount: 1, excludedCardTransactionCount: 1 });
    expect(await prisma.cardSpendEvent.count({ where: { externalEventId: { startsWith: 'task102-history-' } } })).toBe(1);
    expect(await prisma.cardSpendEvent.count({ where: { cardId: 'task102-admin-test' } })).toBe(0);
  });

  function transaction() {
    return {
      transactionId: 'task102-eur-1',
      cardId: 'task102-card-1',
      settleStatus: 'Settled',
      status: 'succeed',
      transactionType: 'auth',
      txnDate: '2026-08-19T12:00:00.000Z',
      transactionAmount: '8.25',
      transactionCurrency: 'EUR',
      txnPrincipalChangeSettledAmount: '-9.74',
      txnPrincipalChangeCurrency: 'USD',
      settlementDate: '2026-08-20T00:00:00.000Z',
      createdAt: '2026-08-20T00:00:01.000Z',
    };
  }

  function verificationContext() {
    return {
      taskId: randomUUID(),
      sourceType: SyncTaskSourceType.card_spend,
      taskType: SyncTaskType.photonpay_card,
      platform: SyncTaskPlatform.photonpay,
      provider: Provider.photonpay,
      settlementMonth: new Date('2026-08-01T00:00:00.000Z'),
      requestedBy: null,
      requestPayload: {
        verificationWindow: { from: '2026-08-18T16:00:00.000Z', to: '2026-08-19T16:00:00.000Z' },
      },
      credential: credential(),
    };
  }

  function historicalContext(previewOnly: boolean) {
    return {
      taskId: randomUUID(),
      sourceType: SyncTaskSourceType.card_spend,
      taskType: SyncTaskType.photonpay_card,
      platform: SyncTaskPlatform.photonpay,
      provider: Provider.photonpay,
      settlementMonth: new Date('2026-07-01T00:00:00.000Z'),
      requestedBy: null,
      requestPayload: {
        historicalBackfill: {
          from: '2026-06-30T16:00:00.000Z',
          to: '2026-07-02T16:00:00.000Z',
          previewOnly,
        },
      },
      credential: credential(),
    };
  }

  function credential() {
    return {
      credentialId: randomUUID(),
      hasCredential: true as const,
      maskedPayload: {},
      payload: { appId: 'task102-app', appSecret: 'task102-secret' },
    };
  }
});

function withSchema(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}
