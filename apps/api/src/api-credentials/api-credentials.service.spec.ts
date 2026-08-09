import { CommonStatus, Provider } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApiCredentialsService } from './api-credentials.service';

const actor = {
  userId: '00000000-0000-0000-0000-000000000001',
  roleCode: 'finance',
  permissions: ['api_config.manage'],
  ipAddress: '127.0.0.1',
  userAgent: 'jest',
};

describe('ApiCredentialsService', () => {
  const originalKey = process.env.API_CREDENTIAL_ENCRYPTION_KEY;
  let prisma: {
    affiliateAccount: { findMany: jest.Mock; findUnique: jest.Mock };
    affiliateAccountCredential: { findUnique: jest.Mock; findMany: jest.Mock; upsert: jest.Mock; update: jest.Mock };
    cardProviderCredential: { findUnique: jest.Mock; findMany: jest.Mock; upsert: jest.Mock; update: jest.Mock };
  };
  let audit: { success: jest.Mock; failure: jest.Mock };
  let service: ApiCredentialsService;

  beforeEach(() => {
    process.env.API_CREDENTIAL_ENCRYPTION_KEY = '12345678901234567890123456789012';
    prisma = {
      affiliateAccount: { findMany: jest.fn(), findUnique: jest.fn() },
      affiliateAccountCredential: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
      cardProviderCredential: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
    };
    audit = {
      success: jest.fn().mockResolvedValue({ id: 'audit-success' }),
      failure: jest.fn().mockResolvedValue({ id: 'audit-failure' }),
    };
    service = new ApiCredentialsService(
      prisma as unknown as PrismaService,
      new CredentialCryptoService(),
      audit as unknown as AuditService,
    );
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.API_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.API_CREDENTIAL_ENCRYPTION_KEY = originalKey;
    }
  });

  it('creates affiliateAccount credential with encrypted storage and no plaintext payload in result', async () => {
    prisma.affiliateAccount.findUnique.mockResolvedValue(affiliateAccount('everflow'));
    prisma.affiliateAccountCredential.upsert.mockImplementation(async (args) =>
      credential({ ...args.create, id: 'cred-1', updatedAt: new Date(Date.UTC(2026, 5, 19)) }),
    );

    const result = await service.upsertAffiliateAccount(
      '10000000-0000-0000-0000-000000000001',
      { payload: { apiKey: 'abcd12345678wxyz', baseUrl: 'https://api.eflow.team' } },
      actor,
    );

    const upsertArgs = prisma.affiliateAccountCredential.upsert.mock.calls[0][0];
    expect(upsertArgs.create.encryptedPayload).not.toContain('abcd12345678wxyz');
    expect(JSON.parse(upsertArgs.create.encryptedPayload)).toEqual(
      expect.objectContaining({ alg: 'aes-256-gcm', iv: expect.any(String), tag: expect.any(String), ciphertext: expect.any(String) }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        affiliateAccountId: '10000000-0000-0000-0000-000000000001',
        hasCredential: true,
        maskedPayload: { apiKey: 'abcd****wxyz', baseUrl: 'https://api.eflow.team' },
      }),
    );
    expect(JSON.stringify(result)).not.toContain('abcd12345678wxyz');
  });

  it('updates affiliateAccount credential, overwrites encryptedPayload, and writes audit', async () => {
    const before = credential({
      id: 'cred-1',
      affiliateAccountId: '10000000-0000-0000-0000-000000000001',
      encryptedPayload: 'old-encrypted',
      maskedPayload: { apiKey: 'old****cret' },
      status: CommonStatus.disabled,
    });
    prisma.affiliateAccount.findUnique.mockResolvedValue(affiliateAccount('cake', before));
    prisma.affiliateAccountCredential.upsert.mockImplementation(async (args) =>
      credential({
        ...before,
        ...args.update,
        updatedAt: new Date(Date.UTC(2026, 5, 20)),
      }),
    );

    await service.upsertAffiliateAccount(
      '10000000-0000-0000-0000-000000000001',
      { payload: { apiKey: 'new-api-key-0001', baseUrl: 'https://cake.example.test/affiliates/api' } },
      actor,
    );

    const updateArgs = prisma.affiliateAccountCredential.upsert.mock.calls[0][0].update;
    expect(updateArgs.encryptedPayload).not.toBe('old-encrypted');
    expect(updateArgs.encryptedPayload).not.toContain('new-api-key-0001');
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'api_credential.affiliate_account.upsert',
        objectType: 'affiliate_account_credentials',
        changedFields: expect.arrayContaining(['encryptedPayload', 'maskedPayload', 'status']),
      }),
    );
  });

  it('disables affiliateAccount credential and writes audit', async () => {
    const before = credential({
      id: 'cred-1',
      affiliateAccountId: '10000000-0000-0000-0000-000000000001',
      status: CommonStatus.active,
    });
    prisma.affiliateAccount.findUnique.mockResolvedValue(affiliateAccount('everflow', before));
    prisma.affiliateAccountCredential.update.mockResolvedValue(credential({ ...before, status: CommonStatus.disabled }));

    const result = await service.disableAffiliateAccount('10000000-0000-0000-0000-000000000001', actor);

    expect(result.status).toBe(CommonStatus.disabled);
    expect(audit.success).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'api_credential.affiliate_account.disable',
        objectType: 'affiliate_account_credentials',
        changedFields: expect.arrayContaining(['status']),
      }),
    );
  });

  it('rejects affiliateAccount.platform that is not everflow or cake', async () => {
    prisma.affiliateAccount.findUnique.mockResolvedValue(affiliateAccount('unknown_network'));

    await expect(
      service.upsertAffiliateAccount(
        '10000000-0000-0000-0000-000000000001',
        { payload: { apiKey: 'abcd12345678wxyz' } },
        actor,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    expect(prisma.affiliateAccountCredential.upsert).not.toHaveBeenCalled();
  });

  it('uses accountCode as read-only CAKE Affiliate ID and rejects duplicate affiliateId input', async () => {
    prisma.affiliateAccount.findUnique.mockResolvedValue({
      ...affiliateAccount('cake'),
      accountCode: '329',
    });
    prisma.affiliateAccountCredential.upsert.mockImplementation(async (args) =>
      credential({ ...args.create, id: 'cred-cake' }),
    );

    const result = await service.upsertAffiliateAccount(
      '10000000-0000-0000-0000-000000000001',
      { payload: { apiKey: 'new-cake-key-0001', baseUrl: 'https://cake.example.test/affiliates/api' } },
      actor,
    );
    expect(result).toMatchObject({ affiliateId: '329', accountCode: '329' });
    const encrypted = prisma.affiliateAccountCredential.upsert.mock.calls[0][0].create.encryptedPayload;
    expect(JSON.stringify(encrypted)).not.toContain('affiliateId');

    await expect(
      service.upsertAffiliateAccount(
        '10000000-0000-0000-0000-000000000001',
        {
          payload: {
            apiKey: 'new-cake-key-0002',
            baseUrl: 'https://cake.example.test/affiliates/api',
            affiliateId: '329',
          },
        },
        actor,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Affiliate ID is read-only and comes from affiliateAccount.accountCode.',
    });
  });

  it('creates card provider credential only for airwallex/photonpay', async () => {
    prisma.cardProviderCredential.findUnique.mockResolvedValue(null);
    prisma.cardProviderCredential.upsert.mockImplementation(async (args) =>
      credential({ ...args.create, id: 'card-cred-1', provider: Provider.airwallex }),
    );

    const result = await service.upsertCardProvider(
      'airwallex',
      { payload: { clientId: 'client-123456789', secret: 'secret-123456789' } },
      actor,
    );

    expect(result).toEqual(expect.objectContaining({ provider: Provider.airwallex, hasCredential: true }));
    await expect(
      service.upsertCardProvider('stripe', { payload: { token: 'token-123456789' } }, actor),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
  });

  it('throws a clear error when API_CREDENTIAL_ENCRYPTION_KEY is missing', async () => {
    delete process.env.API_CREDENTIAL_ENCRYPTION_KEY;
    prisma.affiliateAccount.findUnique.mockResolvedValue(affiliateAccount('everflow'));

    await expect(
      service.upsertAffiliateAccount(
        '10000000-0000-0000-0000-000000000001',
        { payload: { apiKey: 'abcd12345678wxyz' } },
        actor,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'API_CREDENTIAL_ENCRYPTION_KEY is required for API credential encryption.',
    });
    expect(prisma.affiliateAccountCredential.upsert).not.toHaveBeenCalled();
  });

  it('does not write raw apiKey/secret/token values into audit payloads', async () => {
    prisma.cardProviderCredential.findUnique.mockResolvedValue(null);
    prisma.cardProviderCredential.upsert.mockImplementation(async (args) =>
      credential({ ...args.create, id: 'card-cred-1', provider: Provider.photonpay }),
    );

    await service.upsertCardProvider(
      'photonpay',
      { payload: { appId: 'appId-raw-123456', appSecret: 'secret-raw-123456' } },
      actor,
    );

    const auditPayload = JSON.stringify(audit.success.mock.calls[0][0]);
    expect(auditPayload).not.toContain('appId-raw-123456');
    expect(auditPayload).not.toContain('secret-raw-123456');
    expect(auditPayload).toContain('appI****3456');
    expect(auditPayload).toContain('secr****3456');
  });
});

function affiliateAccount(platform: string, credentialRecord: ReturnType<typeof credential> | null = null) {
  return {
    id: '10000000-0000-0000-0000-000000000001',
    platform,
    accountCode: 'acct-1',
    accountName: 'Account 1',
    credential: credentialRecord,
  };
}

function credential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-1',
    affiliateAccountId: '10000000-0000-0000-0000-000000000001',
    encryptedPayload: 'encrypted',
    maskedPayload: { apiKey: 'abcd****wxyz' },
    status: CommonStatus.active,
    createdBy: actor.userId,
    updatedBy: actor.userId,
    createdAt: new Date(Date.UTC(2026, 5, 19)),
    updatedAt: new Date(Date.UTC(2026, 5, 19)),
    ...overrides,
  };
}
