import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import {
  CommonStatus,
  PrismaClient,
  Provider,
  ProviderCardExclusionReason,
  ProviderCardMatchSource,
  ProviderCardMatchStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PhotonPayCardGovernanceService } from './photonpay-card-governance.service';
import { emailDigest } from './provider-card-matching';

const databaseDescribe = process.env.TASK101_DATABASE_TESTS === '1' ? describe : describe.skip;

databaseDescribe('task101 PhotonPay governance on isolated PostgreSQL', () => {
  const baseUrl = process.env.DATABASE_URL!;
  const schema = `task101_${randomUUID().replace(/-/g, '')}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const root = path.resolve(__dirname, '../../../..');
  const prisma = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  const actorId = '10110110-1101-4101-8101-101101101101';
  const actor = {
    userId: actorId,
    roleCode: 'super_admin',
    permissions: ['photonpay_rematch.execute', 'provider_card_exclusion.manage'],
  } as any;
  let employeeId: string;
  let secondEmployeeId: string;
  let aliasId: string;
  let normalProviderCardId: string;

  beforeAll(async () => {
    const command = process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'pnpm db:migrate'] }
      : { file: 'pnpm', args: ['db:migrate'] };
    execFileSync(command.file, command.args, { cwd: root, env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: 'pipe' });
    await prisma.$connect();
    await prisma.adminUser.create({
      data: { id: actorId, username: 'task101-admin', displayName: 'Task 101', passwordHash: 'not-a-login-fixture', status: CommonStatus.active },
    });
    const [employee, secondEmployee] = await Promise.all([
      prisma.employee.create({ data: { employeeCode: 'TASK101-A', name: 'Task 101 A', email: 'current-a@example.test', status: CommonStatus.active } }),
      prisma.employee.create({ data: { employeeCode: 'TASK101-B', name: 'Task 101 B', email: 'current-b@example.test', status: CommonStatus.active } }),
    ]);
    employeeId = employee.id;
    secondEmployeeId = secondEmployee.id;
    const account = await prisma.affiliateAccount.create({ data: { platform: 'cake', accountCode: 'task101-account', status: CommonStatus.active } });
    await prisma.subIdMapping.create({
      data: {
        affiliateAccountId: account.id,
        subField: 'sub1',
        subValue: 'task101-sub',
        effectiveMonth: new Date('2026-08-01T00:00:00.000Z'),
        employeeId,
        status: CommonStatus.active,
      },
    });
    await prisma.providerCard.createMany({
      data: [
        providerCard('task101-card-frozen', 'FROZEN'),
        providerCard('task101-card-cancelled', 'CANCELLED'),
        providerCard('task101-card-normal', 'NORMAL'),
      ],
    });
    normalProviderCardId = (await prisma.providerCard.findUniqueOrThrow({
      where: { provider_cardId: { provider: Provider.photonpay, cardId: 'task101-card-normal' } },
      select: { id: true },
    })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    const cleanup = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.$disconnect();
  });

  it('applies all migrations and creates the additive tables, constraints, and permissions', async () => {
    const migrations = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
    `;
    expect(Number(migrations[0].count)).toBe(19);
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema}
        AND table_name IN ('provider_email_aliases', 'provider_card_accounting_exclusions', 'provider_card_match_resolutions')
      ORDER BY table_name
    `;
    expect(tables.map((row) => row.table_name)).toEqual([
      'provider_card_accounting_exclusions',
      'provider_card_match_resolutions',
      'provider_email_aliases',
    ]);
    const permissionCount = await prisma.permission.count({
      where: { code: { in: ['photonpay_unmatched.read', 'photonpay_email_alias.manage', 'photonpay_rematch.execute', 'provider_card_exclusion.manage'] } },
    });
    expect(permissionCount).toBe(4);
  });

  it('enforces PhotonPay-only aliases and rejects overlapping active periods under PostgreSQL', async () => {
    const alias = await prisma.providerEmailAlias.create({ data: {
      provider: Provider.photonpay,
      aliasEmailNormalized: 'old@example.test',
      employeeId,
      status: CommonStatus.active,
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validTo: null,
      createdBy: actorId,
      updatedBy: actorId,
    } });
    aliasId = alias.id;
    await expect(prisma.providerEmailAlias.create({ data: {
      provider: Provider.photonpay,
      aliasEmailNormalized: 'old@example.test',
      employeeId: secondEmployeeId,
      status: CommonStatus.active,
      validFrom: new Date('2026-06-01T00:00:00.000Z'),
      validTo: null,
      createdBy: actorId,
      updatedBy: actorId,
    } })).rejects.toBeDefined();
    await expect(prisma.providerEmailAlias.create({ data: {
      provider: Provider.airwallex,
      aliasEmailNormalized: 'airwallex@example.test',
      employeeId,
      status: CommonStatus.active,
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validTo: null,
      createdBy: actorId,
      updatedBy: actorId,
    } })).rejects.toBeDefined();

    const airwallexCard = await prisma.providerCard.create({
      data: {
        provider: Provider.airwallex,
        cardId: 'task101-airwallex-card',
        matchStatus: ProviderCardMatchStatus.unmatched,
      },
    });
    await expect(prisma.providerCardAccountingExclusion.create({ data: {
      providerCardId: airwallexCard.id,
      reason: ProviderCardExclusionReason.admin_test_card,
      status: CommonStatus.active,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      createdBy: actorId,
      updatedBy: actorId,
    } })).rejects.toBeDefined();
  });

  it('serializes concurrent overlapping alias writes so exactly one mapping wins', async () => {
    const common = {
      provider: Provider.photonpay,
      aliasEmailNormalized: 'concurrent@example.test',
      status: CommonStatus.active,
      validTo: null,
      createdBy: actorId,
      updatedBy: actorId,
    };
    const results = await Promise.allSettled([
      prisma.providerEmailAlias.create({ data: { ...common, employeeId, validFrom: new Date('2026-01-01T00:00:00.000Z') } }),
      prisma.providerEmailAlias.create({ data: { ...common, employeeId: secondEmployeeId, validFrom: new Date('2026-06-01T00:00:00.000Z') } }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await prisma.providerEmailAlias.count({ where: { aliasEmailNormalized: 'concurrent@example.test' } })).toBe(1);
  });

  it('batch matches all cards in the alias group, preserves original reasons, and is idempotent', async () => {
    expect(aliasId).toBeTruthy();
    const service = new PhotonPayCardGovernanceService(prisma as never, new AuditService(prisma as never));
    const first = await service.executeRematch({ confirm: true }, actor);
    expect(first).toMatchObject({ matchedByAlias: 3, remainingUnmatched: 0, resolvedExceptionCount: 3, changedCount: 3 });
    expect(await prisma.providerCard.count({
      where: { provider: Provider.photonpay, matchStatus: ProviderCardMatchStatus.matched, matchSource: ProviderCardMatchSource.provider_email_alias },
    })).toBe(3);
    const resolutions = await prisma.providerCardMatchResolution.findMany({ orderBy: { resolvedAt: 'asc' } });
    expect(resolutions).toHaveLength(3);
    expect(resolutions.every((item) => item.previousReasonCode === 'EMPLOYEE_NOT_FOUND')).toBe(true);
    const auditCount = await prisma.auditLog.count({ where: { action: 'photonpay_provider_card.rematch' } });

    const second = await service.executeRematch({ confirm: true }, actor);
    expect(second).toMatchObject({ processedCount: 0, changedCount: 0, resolvedExceptionCount: 0 });
    expect(await prisma.providerCardMatchResolution.count()).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: 'photonpay_provider_card.rematch' } })).toBe(auditCount);

    const repeatedMapping = await service.createAlias({
      groupKey: emailDigest('old@example.test'),
      employeeId,
      confirm: true,
    }, actor);
    expect(repeatedMapping).toMatchObject({ idempotent: true, rematch: { processedCount: 0, changedCount: 0 } });
    expect(await prisma.providerEmailAlias.count({ where: { aliasEmailNormalized: 'old@example.test' } })).toBe(1);
    expect(await prisma.providerCardMatchResolution.count()).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: 'photonpay_email_alias.create' } })).toBe(0);

    const correctionAuditCount = await prisma.auditLog.count({ where: { action: 'photonpay_email_alias.correct' } });
    const repeatedCorrection = await service.correctAlias(aliasId, {
      employeeId,
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validTo: null,
      confirm: true,
    }, actor);
    expect(repeatedCorrection).toMatchObject({ idempotent: true, rematch: { processedCount: 0, changedCount: 0 } });
    expect(await prisma.auditLog.count({ where: { action: 'photonpay_email_alias.correct' } })).toBe(correctionAuditCount);
    expect(await prisma.providerCardMatchResolution.count()).toBe(3);

    await expect(prisma.providerCardMatchResolution.update({
      where: { id: resolutions[0].id },
      data: { newReasonCode: 'MUTATION_MUST_FAIL' },
    })).rejects.toBeDefined();
    await expect(prisma.providerCardMatchResolution.delete({ where: { id: resolutions[0].id } })).rejects.toBeDefined();
    expect(await prisma.providerCardMatchResolution.count()).toBe(3);
  });

  it('creates an effective admin test-card exclusion, blocks overlap, and never deletes existing history', async () => {
    const service = new PhotonPayCardGovernanceService(prisma as never, new AuditService(prisma as never));
    const effectiveFrom = new Date('2026-08-21T00:00:00.000Z');
    const created = await service.createExclusion({ providerCardId: normalProviderCardId, effectiveFrom, confirm: true }, actor);
    expect(created).toMatchObject({ idempotent: false, preview: { existingCardSpendEventCount: 0, canApply: true } });
    expect(await prisma.providerCard.findUniqueOrThrow({ where: { id: normalProviderCardId } })).toMatchObject({
      employeeId: null,
      matchStatus: ProviderCardMatchStatus.excluded,
      unmatchedReasonCode: 'ADMIN_TEST_CARD',
    });
    const repeated = await service.createExclusion({ providerCardId: normalProviderCardId, effectiveFrom, confirm: true }, actor);
    expect(repeated).toMatchObject({ idempotent: true });
    expect(await prisma.providerCardAccountingExclusion.count({ where: { providerCardId: normalProviderCardId } })).toBe(1);
    await expect(prisma.providerCardAccountingExclusion.create({ data: {
      providerCardId: normalProviderCardId,
      reason: ProviderCardExclusionReason.admin_test_card,
      status: CommonStatus.active,
      effectiveFrom: new Date('2026-08-22T00:00:00.000Z'),
      effectiveTo: null,
      createdBy: actorId,
      updatedBy: actorId,
    } })).rejects.toBeDefined();
    expect(await prisma.cardSpendEvent.count({ where: { provider: Provider.photonpay } })).toBe(0);
  });

  it('reports and blocks an exclusion when historical CardSpendEvent rows already exist', async () => {
    const card = await prisma.providerCard.create({ data: {
      provider: Provider.photonpay,
      cardId: 'task101-card-with-history',
      maskedCardNumber: '****2020',
      providerStatus: 'NORMAL',
      cardholderEmailNormalized: 'current-a@example.test',
      employeeId,
      matchStatus: ProviderCardMatchStatus.matched,
      matchSource: ProviderCardMatchSource.employee_primary_email,
    } });
    await prisma.cardSpendEvent.create({ data: {
      settlementMonth: new Date('2026-08-01T00:00:00.000Z'),
      provider: Provider.photonpay,
      cardId: 'task101-card-with-history',
      employeeId,
      externalEventId: 'task101-existing-spend',
      transactionAt: new Date('2026-08-10T12:00:00.000Z'),
      amount: '10',
      currency: 'USD',
      spendUsd: '10',
      status: CommonStatus.confirmed,
    } });
    const service = new PhotonPayCardGovernanceService(prisma as never, new AuditService(prisma as never));
    const input = { providerCardId: card.id, effectiveFrom: new Date('2026-08-21T00:00:00.000Z'), confirm: true };
    await expect(service.previewExclusion(input)).resolves.toMatchObject({
      existingCardSpendEventCount: 1,
      existingSpendUsd: '10',
      existingMonths: [{ month: '2026-08', count: 1 }],
      canApply: false,
      blocker: 'EXISTING_CARD_SPEND_EVENTS_REQUIRE_PRODUCT_DECISION',
    });
    await expect(service.createExclusion(input, actor)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CONFLICT' }) });
    expect(await prisma.cardSpendEvent.count({ where: { externalEventId: 'task101-existing-spend' } })).toBe(1);
    expect(await prisma.providerCardAccountingExclusion.count({ where: { providerCardId: card.id } })).toBe(0);

    const summary = await service.safeSummary();
    expect(summary).toMatchObject({
      provider: Provider.photonpay,
      totalCards: 4,
      matched: 3,
      unmatched: 0,
      conflict: 0,
      excluded: 1,
      matchedByAlias: 2,
      activeAliasCount: 2,
      activeExclusionCount: 1,
      excludedCardHistoricalEventCount: 0,
    });
    expect(Object.keys(summary).join(',')).not.toMatch(/email|cardId|employeeId|month$/i);
  });
});

function providerCard(cardId: string, providerStatus: string) {
  return {
    provider: Provider.photonpay,
    cardId,
    cardholderEmailNormalized: 'old@example.test',
    maskedCardNumber: '****1010',
    providerStatus,
    matchStatus: ProviderCardMatchStatus.unmatched,
    unmatchedReasonCode: 'EMPLOYEE_NOT_FOUND',
  };
}

function withSchema(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}
