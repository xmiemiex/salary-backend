import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import { PrismaClient, Provider, ProviderCardMatchStatus } from '@prisma/client';
import { ProviderCardInventoryService } from './provider-card-inventory.service';

const databaseDescribe = process.env.TASK97_DATABASE_TESTS === '1' ? describe : describe.skip;

databaseDescribe('task97 provider card inventory on isolated PostgreSQL', () => {
  const baseUrl = process.env.DATABASE_URL!;
  const schema = `task97_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  const prisma = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  let employeeId: string;

  beforeAll(async () => {
    const command = process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm db:migrate'] }
      : { file: 'pnpm', args: ['db:migrate'] };
    execFileSync(command.file, command.args, { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' });
    await prisma.$connect();
    const employee = await prisma.employee.create({ data: { employeeCode: 'TASK97', name: 'Task 97', email: 'task97@example.test', status: 'active' } });
    employeeId = employee.id;
    const account = await prisma.affiliateAccount.create({ data: { platform: 'cake', accountCode: 'task97-account', status: 'active' } });
    await prisma.subIdMapping.create({ data: { affiliateAccountId: account.id, subField: 'sub1', subValue: 'task97-sub', effectiveMonth: new Date('2026-06-01T00:00:00.000Z'), employeeId, status: 'active' } });
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    const cleanup = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.$disconnect();
  });

  it('applies all 18 migrations and creates only allowlisted card columns', async () => {
    const migrations = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    expect(Number(migrations[0].count)).toBe(18);
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = 'provider_cards' ORDER BY column_name
    `;
    const names = columns.map((row) => row.column_name);
    expect(names).toEqual(expect.arrayContaining(['card_id', 'masked_card_number', 'cardholder_email_normalized', 'match_status']));
    expect(names).not.toEqual(expect.arrayContaining(['card_no', 'card_number', 'cvv', 'pin', 'raw_data']));
  });

  it('idempotently upserts one stable row per provider and external card ID', async () => {
    const key = { provider_cardId: { provider: Provider.photonpay, cardId: 'card-1' } };
    await prisma.providerCard.upsert({ where: key, create: providerCardData(), update: { nickname: 'first' } });
    await prisma.providerCard.upsert({ where: key, create: providerCardData(), update: { nickname: 'second', providerStatus: 'FROZEN' } });
    expect(await prisma.providerCard.count({ where: { provider: Provider.photonpay, cardId: 'card-1' } })).toBe(1);
    await expect(prisma.providerCard.findUniqueOrThrow({ where: key })).resolves.toMatchObject({ nickname: 'second', providerStatus: 'FROZEN' });
  });

  it('resolves the employee once across months even when multiple affiliate SUB mappings exist', async () => {
    const secondAccount = await prisma.affiliateAccount.create({ data: { platform: 'everflow', accountCode: 'task97-account-2', status: 'active' } });
    await prisma.subIdMapping.create({ data: {
      affiliateAccountId: secondAccount.id, subField: 'sub1', subValue: 'task97-sub-2',
      effectiveMonth: new Date('2026-06-01T00:00:00.000Z'), employeeId, status: 'active',
    } });
    const service = new ProviderCardInventoryService(prisma as never, {} as never, {} as never, {} as never, {} as never);
    await expect(service.resolveSpendOwner(Provider.photonpay, 'card-1', new Date('2026-06-01T00:00:00.000Z'))).resolves.toMatchObject({
      ok: true,
      employeeId,
    });
    await expect(service.resolveSpendOwner(Provider.photonpay, 'card-1', new Date('2026-07-01T00:00:00.000Z'))).resolves.toMatchObject({
      ok: true,
      employeeId,
    });
  });

  it('enforces provider plus card ID uniqueness at PostgreSQL level', async () => {
    await expect(prisma.providerCard.create({ data: providerCardData() })).rejects.toMatchObject({ code: 'P2002' });
  });

  function providerCardData() {
    return {
      provider: Provider.photonpay,
      cardId: 'card-1',
      maskedCardNumber: '****1234',
      cardholderEmailNormalized: 'task97@example.test',
      employeeId,
      matchStatus: ProviderCardMatchStatus.matched,
      providerStatus: 'ACTIVE',
    };
  }
});

function withSchema(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}
