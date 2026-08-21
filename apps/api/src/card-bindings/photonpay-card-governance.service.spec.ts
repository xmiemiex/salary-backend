import {
  CommonStatus,
  Provider,
  ProviderCardMatchSource,
  ProviderCardMatchStatus,
} from '@prisma/client';
import { PhotonPayCardGovernanceService } from './photonpay-card-governance.service';

describe('PhotonPayCardGovernanceService', () => {
  const actor = {
    userId: '11111111-1111-4111-8111-111111111111',
    roleCode: 'super_admin',
    permissions: ['photonpay_rematch.execute'],
    ipAddress: '127.0.0.1',
    userAgent: 'jest',
  } as any;
  let cards: any[];
  let prisma: any;
  let audit: any;
  let service: PhotonPayCardGovernanceService;

  beforeEach(() => {
    cards = [providerCard('card-row-1', 'frozen'), providerCard('card-row-2', 'cancelled')];
    prisma = {
      $transaction: jest.fn(async (work: (tx: any) => Promise<unknown>) => work(prisma)),
      providerCard: {
        findMany: jest.fn(async (args: any) => {
          const onlyUnmatched = args?.where?.matchStatus === ProviderCardMatchStatus.unmatched;
          return cards.filter((card) => !onlyUnmatched || card.matchStatus === ProviderCardMatchStatus.unmatched)
            .map((card) => selectCard(card, args?.select));
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const card = cards.find((candidate) => candidate.id === where.id);
          Object.assign(card, data);
          return card;
        }),
      },
      employee: {
        findMany: jest.fn().mockResolvedValue([{ id: 'employee-1', email: 'current@example.test', status: CommonStatus.active }]),
      },
      providerEmailAlias: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'alias-1',
          provider: Provider.photonpay,
          aliasEmailNormalized: 'old@example.test',
          employeeId: 'employee-1',
          status: CommonStatus.active,
          validFrom: new Date('2026-01-01T00:00:00.000Z'),
          validTo: null,
        }]),
      },
      providerCardAccountingExclusion: { findMany: jest.fn().mockResolvedValue([]) },
      providerCardMatchResolution: { create: jest.fn().mockResolvedValue({}) },
      subIdMapping: { findMany: jest.fn().mockResolvedValue([effectiveSub()]) },
    };
    audit = { success: jest.fn().mockResolvedValue({}) };
    service = new PhotonPayCardGovernanceService(prisma, audit);
  });

  it('matches every card in one historical email group by alias and preserves append-only resolution evidence', async () => {
    const result = await service.executeRematch({ confirm: true }, actor);
    expect(result).toMatchObject({
      matchedByAlias: 2,
      remainingUnmatched: 0,
      conflict: 0,
      resolvedExceptionCount: 2,
      processedCount: 2,
      changedCount: 2,
    });
    expect(cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ employeeId: 'employee-1', matchStatus: ProviderCardMatchStatus.matched, matchSource: ProviderCardMatchSource.provider_email_alias }),
    ]));
    expect(prisma.providerCardMatchResolution.create).toHaveBeenCalledTimes(2);
    expect(prisma.providerCardMatchResolution.create.mock.calls[0][0].data).toMatchObject({
      previousMatchStatus: ProviderCardMatchStatus.unmatched,
      previousReasonCode: 'EMPLOYEE_NOT_FOUND',
      newMatchStatus: ProviderCardMatchStatus.matched,
      resolutionType: ProviderCardMatchSource.provider_email_alias,
    });
    expect(JSON.stringify(prisma.providerCardMatchResolution.create.mock.calls)).not.toContain('old@example.test');
  });

  it('is idempotent and does not duplicate updates, resolutions, or audits on a second rematch', async () => {
    await service.executeRematch({ confirm: true }, actor);
    jest.clearAllMocks();
    prisma.providerEmailAlias.findMany.mockResolvedValue([]);
    prisma.providerCardAccountingExclusion.findMany.mockResolvedValue([]);
    prisma.subIdMapping.findMany.mockResolvedValue([effectiveSub()]);

    const second = await service.executeRematch({ confirm: true }, actor);

    expect(second).toMatchObject({ processedCount: 0, changedCount: 0, resolvedExceptionCount: 0 });
    expect(prisma.providerCard.update).not.toHaveBeenCalled();
    expect(prisma.providerCardMatchResolution.create).not.toHaveBeenCalled();
    expect(audit.success).not.toHaveBeenCalled();
  });

  it('groups unmatched cards by exact normalized email without exposing provider card IDs', async () => {
    const result = await service.listUnmatchedGroups();
    expect(result).toMatchObject({ totalCards: 2 });
    expect(result.groups).toEqual([expect.objectContaining({
      cardholderEmail: 'old@example.test',
      maskedEmail: 'ol***@e***.test',
      cardCount: 2,
      statusCounts: { frozen: 1, cancelled: 1 },
    })]);
    expect(JSON.stringify(result)).not.toContain('provider-card-1');
  });
});

function providerCard(id: string, providerStatus: string) {
  return {
    id,
    provider: Provider.photonpay,
    cardholderEmailNormalized: 'old@example.test',
    providerStatus,
    employeeId: null,
    matchStatus: ProviderCardMatchStatus.unmatched,
    matchSource: null,
    unmatchedReasonCode: 'EMPLOYEE_NOT_FOUND',
  };
}

function selectCard(card: any, select: Record<string, boolean> | undefined) {
  if (!select) return { ...card };
  return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, card[key]]));
}

function effectiveSub() {
  return {
    id: 'mapping-1',
    affiliateAccountId: 'account-1',
    subField: 'sub1',
    subValue: 'SUB-1',
    effectiveMonth: new Date('2026-08-01T00:00:00.000Z'),
    employeeId: 'employee-1',
    status: CommonStatus.active,
    employee: { employeeCode: 'E001', name: 'Employee', status: CommonStatus.active },
  };
}
