import { AirwallexCardDiscoveryService } from './airwallex-card-discovery.service';
import { SyncExecutionErrorCategory } from '@prisma/client';
import { ProviderRequestError } from '../sync-tasks/provider-request-error';

describe('AirwallexCardDiscoveryService', () => {
  const credentialSecret = 'airwallex-secret-that-must-not-leak';
  let prisma: { employee: { findMany: jest.Mock } };
  let credentials: { getCardProviderCredentialPayload: jest.Mock };
  let client: { listCards: jest.Mock; listCardholders: jest.Mock };
  let service: AirwallexCardDiscoveryService;

  beforeEach(() => {
    prisma = { employee: { findMany: jest.fn() } };
    credentials = {
      getCardProviderCredentialPayload: jest.fn().mockResolvedValue({
        credentialId: 'credential-1',
        payload: { clientId: 'client-id', apiKey: credentialSecret },
        maskedPayload: {},
      }),
    };
    client = {
      listCards: jest.fn().mockResolvedValue({
        cards: [
          {
            card_id: 'card-1',
            card_number: '************1234',
            card_status: 'ACTIVE',
            nick_name: 'Meta Ads',
            cardholder_id: 'holder-1',
          },
          {
            card_id: 'card-2',
            card_number: '************5678',
            card_status: 'ACTIVE',
            cardholder_id: 'holder-1',
            additional_cardholder_ids: ['holder-2'],
          },
        ],
        hasMore: false,
      }),
      listCardholders: jest.fn().mockResolvedValue({
        cardholders: [
          {
            cardholder_id: 'holder-1',
            email: 'zw@example.test',
            individual: { name: { first_name: 'ZW', last_name: 'Employee' } },
          },
        ],
        hasMore: false,
      }),
    };
    prisma.employee.findMany.mockResolvedValue([
      { id: 'employee-1', employeeCode: '01', name: 'ZW', email: 'ZW@example.test' },
      { id: 'employee-2', employeeCode: '02', name: 'MSY', email: null },
    ]);
    service = new AirwallexCardDiscoveryService(prisma as never, credentials as never, client as never);
  });

  it('discovers every card and only suggests an employee for a unique exact email match', async () => {
    const result = await service.discover();

    expect(client.listCards).toHaveBeenCalledWith(expect.objectContaining({ page: 0, pageSize: 200 }));
    expect(client.listCardholders).toHaveBeenCalledWith(expect.objectContaining({ page: 0, pageSize: 200 }));
    expect(result.cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cardId: 'card-1',
          last4: '1234',
          cardholderName: 'ZW Employee',
          cardholderEmail: 'zw@example.test',
          suggestedEmployeeId: 'employee-1',
          suggestedEmployeeCode: '01',
          mappingHint: 'unique_email_match',
        }),
        expect.objectContaining({
          cardId: 'card-2',
          suggestedEmployeeId: null,
          mappingHint: 'multiple_cardholders',
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain(credentialSecret);
    expect(JSON.stringify(result)).not.toContain('************1234');
  });

  it('keeps cards discoverable but returns no employee suggestion when cardholder access is unavailable', async () => {
    client.listCardholders.mockRejectedValue(
      new ProviderRequestError(SyncExecutionErrorCategory.CREDENTIAL_INVALID, 'must not leak', 403),
    );

    const result = await service.discover();

    expect(result.cardCount).toBe(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Cardholders 只读权限');
    expect(result.cards.every((card) => card.suggestedEmployeeId === null)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('must not leak');
  });

  it('returns a safe actionable error when Airwallex rejects card discovery', async () => {
    client.listCards.mockRejectedValue(
      new ProviderRequestError(SyncExecutionErrorCategory.CREDENTIAL_INVALID, 'provider payload must not leak', 403),
    );

    await expect(service.discover()).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('Cards 只读权限'),
    });
    await expect(service.discover()).rejects.not.toThrow('provider payload must not leak');
  });
});
