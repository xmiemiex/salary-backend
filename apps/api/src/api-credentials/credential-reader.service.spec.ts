import { MODULE_METADATA } from '@nestjs/common/constants';
import { CommonStatus, Provider } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApiCredentialsController } from './api-credentials.controller';
import { ApiCredentialsModule } from './api-credentials.module';
import { CredentialReaderService } from './credential-reader.service';

describe('CredentialReaderService', () => {
  const originalKey = process.env.API_CREDENTIAL_ENCRYPTION_KEY;
  const affiliateSecret = 'affiliate-reader-plain-secret';
  const cardSecret = 'card-reader-plain-secret';
  let prisma: {
    affiliateAccountCredential: { findFirst: jest.Mock };
    cardProviderCredential: { findFirst: jest.Mock };
  };
  let audit: { success: jest.Mock; failure: jest.Mock };
  let crypto: CredentialCryptoService;
  let service: CredentialReaderService;

  beforeEach(() => {
    process.env.API_CREDENTIAL_ENCRYPTION_KEY = '12345678901234567890123456789012';
    prisma = {
      affiliateAccountCredential: { findFirst: jest.fn() },
      cardProviderCredential: { findFirst: jest.fn() },
    };
    audit = { success: jest.fn(), failure: jest.fn() };
    crypto = new CredentialCryptoService();
    service = new CredentialReaderService(prisma as unknown as PrismaService, crypto);
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.API_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.API_CREDENTIAL_ENCRYPTION_KEY = originalKey;
    }
  });

  it('reads only active affiliate credential and returns plaintext payload for internal callers', async () => {
    prisma.affiliateAccountCredential.findFirst.mockResolvedValue(
      credential({
        id: 'affiliate-cred-1',
        encryptedPayload: crypto.encryptJson({ apiKey: 'affiliate-key-123', secret: affiliateSecret }),
        maskedPayload: { apiKey: 'affi****-123', secret: 'affi****cret' },
      }),
    );

    const result = await service.getAffiliateAccountCredentialPayload('10000000-0000-0000-0000-000000000001');

    expect(prisma.affiliateAccountCredential.findFirst).toHaveBeenCalledWith({
      where: { affiliateAccountId: '10000000-0000-0000-0000-000000000001', status: CommonStatus.active },
      select: { id: true, encryptedPayload: true, maskedPayload: true, status: true },
    });
    expect(result).toEqual({
      credentialId: 'affiliate-cred-1',
      payload: { apiKey: 'affiliate-key-123', secret: affiliateSecret },
      maskedPayload: { apiKey: 'affi****-123', secret: 'affi****cret' },
    });
    expect(JSON.stringify([audit.success.mock.calls, audit.failure.mock.calls])).not.toContain(affiliateSecret);
  });

  it('does not return plaintext for disabled affiliate credential', async () => {
    prisma.affiliateAccountCredential.findFirst.mockResolvedValue(null);
    const decryptSpy = jest.spyOn(crypto, 'decryptJson');

    await expect(
      service.getAffiliateAccountCredentialPayload('10000000-0000-0000-0000-000000000001'),
    ).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Active affiliate account credential is required.',
    });

    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('reads only active card provider credential and returns plaintext payload for internal callers', async () => {
    prisma.cardProviderCredential.findFirst.mockResolvedValue(
      credential({
        id: 'card-cred-1',
        encryptedPayload: crypto.encryptJson({ clientId: 'card-client-123', secret: cardSecret }),
        maskedPayload: { clientId: 'card****-123', secret: 'card****cret' },
      }),
    );

    const result = await service.getCardProviderCredentialPayload(Provider.airwallex);

    expect(prisma.cardProviderCredential.findFirst).toHaveBeenCalledWith({
      where: { provider: Provider.airwallex, status: CommonStatus.active },
      select: { id: true, encryptedPayload: true, maskedPayload: true, status: true },
    });
    expect(result).toEqual({
      credentialId: 'card-cred-1',
      payload: { clientId: 'card-client-123', secret: cardSecret },
      maskedPayload: { clientId: 'card****-123', secret: 'card****cret' },
    });
    expect(JSON.stringify([audit.success.mock.calls, audit.failure.mock.calls])).not.toContain(cardSecret);
  });

  it('does not return plaintext for disabled card provider credential', async () => {
    prisma.cardProviderCredential.findFirst.mockResolvedValue(null);
    const decryptSpy = jest.spyOn(crypto, 'decryptJson');

    await expect(service.getCardProviderCredentialPayload(Provider.photonpay)).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Active card provider credential is required.',
    });

    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('does not register the internal reader as a controller', () => {
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ApiCredentialsModule);

    expect(controllers).toEqual([ApiCredentialsController]);
    expect(controllers).not.toContain(CredentialReaderService);
  });
});

function credential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-1',
    encryptedPayload: 'encrypted',
    maskedPayload: { apiKey: 'abcd****wxyz' },
    status: CommonStatus.active,
    ...overrides,
  };
}
