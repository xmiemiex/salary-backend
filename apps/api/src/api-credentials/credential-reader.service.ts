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
};

type CredentialRecord = {
  id: string;
  encryptedPayload: string;
  maskedPayload: unknown | null;
  status: CommonStatus;
};

type CredentialReaderPrisma = {
  affiliateAccountCredential: {
    findFirst(args: unknown): Promise<CredentialRecord | null>;
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
    const credential = await this.db().affiliateAccountCredential.findFirst({
      where: { affiliateAccountId, status: CommonStatus.active },
      select: { id: true, encryptedPayload: true, maskedPayload: true, status: true },
    });
    if (!credential || credential.status !== CommonStatus.active) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Active affiliate account credential is required.');
    }
    return this.toInternalPayload(credential);
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
