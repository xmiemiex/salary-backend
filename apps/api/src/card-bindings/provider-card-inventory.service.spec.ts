import { CommonStatus, Provider, ProviderCardMatchStatus, SyncExecutionErrorCategory } from '@prisma/client';
import { ProviderRequestError } from '../sync-tasks/provider-request-error';
import { ProviderCardInventoryService } from './provider-card-inventory.service';

describe('ProviderCardInventoryService', () => {
  let prisma: any;
  let credentials: any;
  let airwallex: any;
  let photonpay: any;
  let audit: any;
  let service: ProviderCardInventoryService;

  beforeEach(() => {
    prisma = {
      employee: { findMany: jest.fn().mockResolvedValue([]) },
      providerCard: {
        upsert: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      subIdMapping: { findMany: jest.fn().mockResolvedValue([]) },
    };
    credentials = { getCardProviderCredentialPayload: jest.fn() };
    airwallex = { listCards: jest.fn(), listCardholders: jest.fn() };
    photonpay = { listCards: jest.fn(), getCardDetail: jest.fn() };
    audit = { success: jest.fn().mockResolvedValue(undefined) };
    service = new ProviderCardInventoryService(prisma, credentials, airwallex, photonpay, audit);
  });

  it('normalizes email and maps exactly one active employee', async () => {
    employeeRows([{ id: 'employee-1', email: ' USER@Example.Test ', status: CommonStatus.active }]);
    photonCards({ email: '  user@example.test ' });

    const result = await service.syncProviderWithPayload(Provider.photonpay, photonCredential());

    expect(result).toMatchObject({ status: 'completed', discoveredCount: 1, matchedCount: 1, unmatchedCount: 0 });
    expect(prisma.providerCard.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        employeeId: 'employee-1',
        cardholderEmailNormalized: 'user@example.test',
        matchStatus: ProviderCardMatchStatus.matched,
        maskedCardNumber: '****1234',
      }),
    }));
    expect(JSON.stringify(prisma.providerCard.upsert.mock.calls)).not.toContain('sensitive-card-value');
    expect(result.mappingDiagnostics).toMatchObject({ employeeWithoutSub: 1, multipleBusinessSubValues: 0 });
  });

  it('treats the same effective business SUB value across accounts as valid', async () => {
    employeeRows([{ id: 'employee-1', email: 'user@example.test', status: CommonStatus.active }]);
    prisma.subIdMapping.findMany.mockResolvedValue([
      effectiveSub('account-cake', 'SAME-SUB'),
      effectiveSub('account-everflow', 'SAME-SUB'),
    ]);
    photonCards({ email: 'user@example.test' });
    const result = await service.syncProviderWithPayload(Provider.photonpay, photonCredential(), new Date('2026-06-01T00:00:00.000Z'));
    expect(result.mappingDiagnostics).toMatchObject({ employeeWithoutSub: 0, multipleBusinessSubValues: 0 });
  });

  it('reports multiple distinct effective business SUB values without choosing one', async () => {
    employeeRows([{ id: 'employee-1', email: 'user@example.test', status: CommonStatus.active }]);
    prisma.subIdMapping.findMany.mockResolvedValue([
      effectiveSub('account-cake', 'SUB-A'),
      effectiveSub('account-everflow', 'SUB-B'),
    ]);
    photonCards({ email: 'user@example.test' });
    const result = await service.syncProviderWithPayload(Provider.photonpay, photonCredential(), new Date('2026-06-01T00:00:00.000Z'));
    expect(result.mappingDiagnostics).toMatchObject({ employeeWithoutSub: 0, multipleBusinessSubValues: 1 });
    expect(prisma.providerCard.upsert.mock.calls[0][0].create.employeeId).toBe('employee-1');
  });

  it.each([
    [null, 'CARDHOLDER_EMAIL_MISSING'],
    ['not-an-email', 'CARDHOLDER_EMAIL_INVALID'],
    ['missing@example.test', 'EMPLOYEE_NOT_FOUND'],
  ])('keeps an unmatched card for email %p with reason %s', async (email, reasonCode) => {
    photonCards({ email });
    await service.syncProviderWithPayload(Provider.photonpay, photonCredential());
    expect(prisma.providerCard.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ employeeId: null, matchStatus: ProviderCardMatchStatus.unmatched, unmatchedReasonCode: reasonCode }),
    }));
  });

  it('does not map an employee whose status is disabled', async () => {
    employeeRows([{ id: 'employee-1', email: 'user@example.test', status: CommonStatus.disabled }]);
    photonCards({ email: 'user@example.test' });
    await service.syncProviderWithPayload(Provider.photonpay, photonCredential());
    expect(prisma.providerCard.upsert.mock.calls[0][0].create).toMatchObject({ employeeId: null, unmatchedReasonCode: 'EMPLOYEE_DISABLED' });
  });

  it('marks duplicate active employee emails as a conflict without choosing one', async () => {
    employeeRows([
      { id: 'employee-1', email: 'user@example.test', status: CommonStatus.active },
      { id: 'employee-2', email: ' USER@example.test ', status: CommonStatus.active },
    ]);
    photonCards({ email: 'user@example.test' });
    const result = await service.syncProviderWithPayload(Provider.photonpay, photonCredential());
    expect(result.conflictCount).toBe(1);
    expect(prisma.providerCard.upsert.mock.calls[0][0].create).toMatchObject({
      employeeId: null, matchStatus: ProviderCardMatchStatus.conflict, unmatchedReasonCode: 'EMPLOYEE_EMAIL_AMBIGUOUS',
    });
  });

  it('treats one active plus one disabled employee with the same normalized email as a conflict', async () => {
    employeeRows([
      { id: 'employee-1', email: 'user@example.test', status: CommonStatus.active },
      { id: 'employee-2', email: ' USER@example.test ', status: CommonStatus.disabled },
    ]);
    photonCards({ email: 'user@example.test' });
    const result = await service.syncProviderWithPayload(Provider.photonpay, photonCredential());
    expect(result).toMatchObject({ matchedCount: 0, conflictCount: 1 });
    expect(result.mappingDiagnostics).toMatchObject({ multipleEmployeeEmail: 1 });
    expect(prisma.providerCard.upsert.mock.calls[0][0].create).toMatchObject({
      employeeId: null, matchStatus: ProviderCardMatchStatus.conflict, unmatchedReasonCode: 'EMPLOYEE_EMAIL_AMBIGUOUS',
    });
  });

  it('paginates every PhotonPay card and retains frozen and closed cards', async () => {
    photonpay.listCards
      .mockResolvedValueOnce({ cards: [listedCard('card-1', 'FROZEN')], hasMore: true })
      .mockResolvedValueOnce({ cards: [listedCard('card-2', 'CLOSED')], hasMore: false });
    photonpay.getCardDetail.mockImplementation(({ cardId }: { cardId: string }) => Promise.resolve({ ...listedCard(cardId, cardId === 'card-1' ? 'FROZEN' : 'CLOSED'), email: null }));
    const result = await service.syncProviderWithPayload(Provider.photonpay, photonCredential());
    expect(result.discoveredCount).toBe(2);
    expect(result.connectionDiagnostics).toMatchObject({
      cardPages: 2,
      cardStatusCounts: { FROZEN: 1, CLOSED: 1 },
      cardOrganizationCounts: { UNKNOWN: 2 },
    });
    expect(photonpay.listCards).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2 }));
    expect(prisma.providerCard.upsert.mock.calls.map((call: any[]) => call[0].create.providerStatus)).toEqual(['FROZEN', 'CLOSED']);
  });

  it('keeps card list metadata when PhotonPay card detail is externally blocked', async () => {
    photonpay.listCards.mockResolvedValue({ cards: [listedCard('card-1', 'ACTIVE')], hasMore: false });
    photonpay.getCardDetail.mockRejectedValue(new ProviderRequestError(SyncExecutionErrorCategory.CREDENTIAL_INVALID, 'denied', 403, 'NO_SCOPE', 'scope denied', 'req-1'));
    const result = await service.syncProviderWithPayload(Provider.photonpay, photonCredential());
    expect(result.status).toBe('partial');
    expect(result.error).toMatchObject({ httpStatus: 403, code: 'NO_SCOPE', requestId: 'req-1' });
    expect(prisma.providerCard.upsert.mock.calls[0][0].create).toMatchObject({ unmatchedReasonCode: 'CARDHOLDER_LOOKUP_FAILED' });
  });

  it('continues PhotonPay when Airwallex is externally blocked during a combined sync', async () => {
    credentials.getCardProviderCredentialPayload.mockImplementation((provider: Provider) => Promise.resolve({
      payload: provider === Provider.airwallex ? { clientId: 'client', apiKey: 'secret' } : photonCredential(),
    }));
    airwallex.listCards.mockRejectedValue(new ProviderRequestError(SyncExecutionErrorCategory.BUSINESS_REJECTED, 'bad request', 400, 'PRODUCT_NOT_ENABLED', 'Issuing unavailable', 'req-air', '2024-02-22'));
    photonpay.listCards.mockResolvedValue({ cards: [], hasMore: false });
    const response = await service.syncAll(actor());
    expect(response.status).toBe('partial');
    expect(response.results[0]).toMatchObject({ provider: Provider.airwallex, status: 'external_blocked' });
    expect(response.results[1]).toMatchObject({ provider: Provider.photonpay, status: 'completed' });
    expect(response.results[0].error).toMatchObject({ code: 'PRODUCT_NOT_ENABLED', requestId: 'req-air' });
    expect(audit.success).toHaveBeenCalledTimes(1);
  });

  it('rejects spend ownership when the card is absent or unmatched', async () => {
    prisma.providerCard.findUnique.mockResolvedValue(null);
    await expect(service.resolveSpendOwner(Provider.airwallex, 'missing', new Date('2026-06-01'))).resolves.toMatchObject({ ok: false, reasonCode: 'CARD_NOT_MAPPED' });
    prisma.providerCard.findUnique.mockResolvedValue({ matchStatus: ProviderCardMatchStatus.unmatched, employeeId: null, employee: null });
    await expect(service.resolveSpendOwner(Provider.airwallex, 'card-1', new Date('2026-06-01'))).resolves.toMatchObject({ ok: false, reasonCode: 'CARD_NOT_MAPPED' });
  });

  it('rejects spend ownership when the previously matched employee is disabled', async () => {
    matchedCard(CommonStatus.disabled);
    await expect(service.resolveSpendOwner(Provider.photonpay, 'card-1', new Date('2026-06-01'))).resolves.toMatchObject({ ok: false, reasonCode: 'EMPLOYEE_DISABLED' });
  });

  it('assigns spend to the uniquely matched active employee without requiring an affiliate SUB mapping', async () => {
    matchedCard(CommonStatus.active);
    const month = new Date('2026-06-01T00:00:00.000Z');
    prisma.subIdMapping.findMany.mockResolvedValueOnce([]);
    await expect(service.resolveSpendOwner(Provider.photonpay, 'card-1', month)).resolves.toEqual({ ok: true, employeeId: 'employee-1' });
    expect(prisma.subIdMapping.findMany).not.toHaveBeenCalled();
  });

  it('allows the same employee to have multiple affiliate mappings without duplicating spend ownership', async () => {
    matchedCard(CommonStatus.active);
    prisma.subIdMapping.findMany.mockResolvedValue([subMapping('cake', 'account-cake'), subMapping('everflow', 'account-everflow')]);
    await expect(service.resolveSpendOwner(Provider.photonpay, 'card-1', new Date('2026-06-01'))).resolves.toEqual({ ok: true, employeeId: 'employee-1' });
    expect(prisma.subIdMapping.findMany).not.toHaveBeenCalled();
  });

  function employeeRows(rows: any[]) { prisma.employee.findMany.mockResolvedValue(rows); }
  function matchedCard(status: CommonStatus) {
    prisma.providerCard.findUnique.mockResolvedValue({ matchStatus: ProviderCardMatchStatus.matched, employeeId: 'employee-1', employee: { id: 'employee-1', status } });
  }
  function photonCards(detail: { email: string | null }) {
    photonpay.listCards.mockResolvedValue({ cards: [listedCard('card-1', 'ACTIVE')], hasMore: false });
    photonpay.getCardDetail.mockResolvedValue({
      ...listedCard('card-1', 'ACTIVE'),
      ...detail,
      cardNo: 'sensitive-card-value',
      maskCardNo: '****1234',
    });
  }
});

function listedCard(cardId: string, cardStatus: string) {
  return { cardId, cardholderId: 'holder-1', email: null, maskCardNo: '****1234', nickname: 'Ads', cardStatus, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
}
function photonCredential() { return { appId: 'app-id', appSecret: 'app-secret' }; }
function subMapping(subValue: string, affiliateAccountId: string) { return { id: `sub-${subValue}`, affiliateAccountId, subField: 'sub1', subValue }; }
function effectiveSub(affiliateAccountId: string, subValue: string) {
  return {
    id: `${affiliateAccountId}-${subValue}`,
    affiliateAccountId,
    subField: 'sub1',
    subValue,
    effectiveMonth: new Date('2026-06-01T00:00:00.000Z'),
    employeeId: 'employee-1',
    status: CommonStatus.active,
    employee: { employeeCode: 'E001', name: 'Employee', status: CommonStatus.active },
  };
}
function actor() { return { userId: 'user-1', roleCode: 'super_admin', permissions: ['card_binding.manage'], ipAddress: '127.0.0.1', userAgent: 'jest' } as any; }
