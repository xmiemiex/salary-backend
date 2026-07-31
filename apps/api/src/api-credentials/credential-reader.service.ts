import { Injectable } from '@nestjs/common';
import { CommonStatus, Provider } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../common/app-error';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { PrismaService } from '../prisma/prisma.service';

export type InternalCredentialPayload = {
  credentialId: string;
  payload: unknown;
  maskedPayload: unknown;
  affiliateAccountCode?: string;
};

type CredentialRecord = {
  id: string;
  encryptedPayload: string;
  maskedPayload: unknown | null;
  status: CommonStatus;
};

type CredentialReaderPrisma = {
  affiliateAccount: {
    findUnique(args: unknown): Promise<{
      platform: string;
      accountCode: string;
      credential: CredentialRecord | null;
    } | null>;
  };
  cardProviderCredential: {
    findFirst(args: unknown): Promise<CredentialRecord | null>;
  };
};

@Injectable()
export class CredentialReaderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CredentialCryptoService,
  ) {}

  async getAffiliateAccountCredentialPayload(affiliateAccountId: string): Promise<InternalCredentialPayload> {
    const account = await this.db().affiliateAccount.findUnique({
      where: { id: affiliateAccountId },
      select: {
        platform: true,
        accountCode: true,
        credential: {
          select: { id: true, encryptedPayload: true, maskedPayload: true, status: true },
        },
      },
    });
    const credential = account?.credential;
    if (!credential || credential.status !== CommonStatus.active) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Active affiliate account credential is required.');
    }
    const internal = this.toInternalPayload(credential);
    if (account.platform.toLowerCase() !== 'cake') return internal;

    const payload = asObject(internal.payload);
    const legacyAffiliateId = optionalString(payload.affiliateId ?? payload.affiliate_id);
    if (legacyAffiliateId && legacyAffiliateId !== account.accountCode) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '联盟账号 Affiliate ID 与历史凭据不一致');
    }
    const { affiliateId: _legacyCamel, affiliate_id: _legacySnake, ...canonicalPayload } = payload;
    return {
      ...internal,
      payload: canonicalPayload,
      affiliateAccountCode: account.accountCode,
    };
  }

  async getCardProviderCredentialPayload(provider: Provider): Promise<InternalCredentialPayload> {
    const credential = await this.db().cardProviderCredential.findFirst({
      where: { provider, status: CommonStatus.active },
      select: { id: true, encryptedPayload: true, maskedPayload: true, status: true },
    });
    if (!credential || credential.status !== CommonStatus.active) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Active card provider credential is required.');
    }
    return this.toInternalPayload(credential);
  }

  private toInternalPayload(credential: CredentialRecord): InternalCredentialPayload {
    return {
      credentialId: credential.id,
      payload: this.crypto.decryptJson(credential.encryptedPayload),
      maskedPayload: credential.maskedPayload,
    };
  }

  private db(): CredentialReaderPrisma {
    return this.prisma as unknown as CredentialReaderPrisma;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Affiliate credential payload is invalid.');
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
