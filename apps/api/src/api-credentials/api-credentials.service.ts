import { Injectable } from '@nestjs/common';
import { CommonStatus, Provider } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { changedFields, notFound, requireNonBlank } from '../base-data/base-data.utils';
import { AppError } from '../common/app-error';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { PrismaService } from '../prisma/prisma.service';

const AFFILIATE_PLATFORMS = ['everflow', 'cake'] as const;
const CARD_PROVIDERS = [Provider.airwallex, Provider.photonpay] as const;

export type UpsertApiCredentialInput = {
  payload: Record<string, unknown>;
};

type CredentialRecord = {
  id: string;
  affiliateAccountId?: string;
  provider?: Provider;
  encryptedPayload: string;
  maskedPayload: unknown | null;
  status: CommonStatus;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type AffiliateAccountRecord = {
  id: string;
  platform: string;
  accountCode: string;
  accountName?: string | null;
  credential?: CredentialRecord | null;
};

type CredentialDelegate = {
  findUnique(args: unknown): Promise<CredentialRecord | null>;
  findMany(args: unknown): Promise<CredentialRecord[]>;
  upsert(args: unknown): Promise<CredentialRecord>;
  update(args: unknown): Promise<CredentialRecord>;
};

type AffiliateAccountDelegate = {
  findMany(args: unknown): Promise<AffiliateAccountRecord[]>;
  findUnique(args: unknown): Promise<AffiliateAccountRecord | null>;
};

type CredentialPrisma = {
  affiliateAccount: AffiliateAccountDelegate;
  affiliateAccountCredential: CredentialDelegate;
  cardProviderCredential: CredentialDelegate;
};

@Injectable()
export class ApiCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CredentialCryptoService,
    private readonly audit: AuditService,
  ) {}

  async listAffiliateAccounts() {
    const accounts = await this.db().affiliateAccount.findMany({
      select: affiliateAccountSelect(),
      orderBy: { createdAt: 'desc' },
    });
    return accounts.map(toAffiliateAccountDto);
  }

  async getAffiliateAccount(affiliateAccountId: string) {
    const account = await this.getAffiliateAccountOrThrow(affiliateAccountId);
    return toAffiliateAccountDto(account);
  }

  async upsertAffiliateAccount(affiliateAccountIdInput: string, input: UpsertApiCredentialInput, actor: Actor) {
    const affiliateAccountId = requireNonBlank(affiliateAccountIdInput, 'affiliateAccountId');
    const payload = validatePayload(input?.payload);
    const maskedPayload = maskPayload(payload);
    const account = await this.getAffiliateAccountOrThrow(affiliateAccountId);
    assertAffiliatePlatform(account.platform);

    const encryptedPayload = this.crypto.encryptJson(payload);
    const beforeAudit = account.credential ? toCredentialAudit(account.credential) : undefined;
    const credential = await this.db().affiliateAccountCredential.upsert({
      where: { affiliateAccountId },
      create: {
        affiliateAccountId,
        encryptedPayload,
        maskedPayload,
        status: CommonStatus.active,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      },
      update: {
        encryptedPayload,
        maskedPayload,
        status: CommonStatus.active,
        updatedBy: actor.userId,
      },
    });
    const afterAudit = toCredentialAudit(credential);

    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'api_credential.affiliate_account.upsert',
      objectType: 'affiliate_account_credentials',
      objectId: credential.id,
      beforeData: beforeAudit,
      afterData: afterAudit,
      changedFields: credentialChangedFields(beforeAudit, afterAudit, true),
      requestPayload: { affiliateAccountId, payload: maskedPayload },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return toAffiliateAccountDto({ ...account, credential });
  }

  async disableAffiliateAccount(affiliateAccountIdInput: string, actor: Actor) {
    const affiliateAccountId = requireNonBlank(affiliateAccountIdInput, 'affiliateAccountId');
    const account = await this.getAffiliateAccountOrThrow(affiliateAccountId);
    if (!account.credential) throw notFound('Affiliate account credential');

    const beforeAudit = toCredentialAudit(account.credential);
    const credential = await this.db().affiliateAccountCredential.update({
      where: { affiliateAccountId },
      data: { status: CommonStatus.disabled, updatedBy: actor.userId },
    });
    const afterAudit = toCredentialAudit(credential);

    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'api_credential.affiliate_account.disable',
      objectType: 'affiliate_account_credentials',
      objectId: credential.id,
      beforeData: beforeAudit,
      afterData: afterAudit,
      changedFields: changedFields(beforeAudit, afterAudit, ['status', 'updatedBy']),
      requestPayload: { affiliateAccountId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return toAffiliateAccountDto({ ...account, credential });
  }

  async listCardProviders() {
    const credentials = await this.db().cardProviderCredential.findMany({
      where: { provider: { in: CARD_PROVIDERS } },
    });
    return CARD_PROVIDERS.map((provider) => toCardProviderDto(provider, credentials.find((credential) => credential.provider === provider) ?? null));
  }

  async getCardProvider(providerInput: string) {
    const provider = normalizeCardProvider(providerInput);
    const credential = await this.db().cardProviderCredential.findUnique({ where: { provider } });
    return toCardProviderDto(provider, credential);
  }

  async upsertCardProvider(providerInput: string, input: UpsertApiCredentialInput, actor: Actor) {
    const provider = normalizeCardProvider(providerInput);
    const payload = validatePayload(input?.payload);
    const maskedPayload = maskPayload(payload);
    const encryptedPayload = this.crypto.encryptJson(payload);
    const before = await this.db().cardProviderCredential.findUnique({ where: { provider } });
    const beforeAudit = before ? toCredentialAudit(before) : undefined;

    const credential = await this.db().cardProviderCredential.upsert({
      where: { provider },
      create: {
        provider,
        encryptedPayload,
        maskedPayload,
        status: CommonStatus.active,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      },
      update: {
        encryptedPayload,
        maskedPayload,
        status: CommonStatus.active,
        updatedBy: actor.userId,
      },
    });
    const afterAudit = toCredentialAudit(credential);

    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'api_credential.card_provider.upsert',
      objectType: 'card_provider_credentials',
      objectId: credential.id,
      beforeData: beforeAudit,
      afterData: afterAudit,
      changedFields: credentialChangedFields(beforeAudit, afterAudit, true),
      requestPayload: { provider, payload: maskedPayload },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return toCardProviderDto(provider, credential);
  }

  async disableCardProvider(providerInput: string, actor: Actor) {
    const provider = normalizeCardProvider(providerInput);
    const before = await this.db().cardProviderCredential.findUnique({ where: { provider } });
    if (!before) throw notFound('Card provider credential');

    const beforeAudit = toCredentialAudit(before);
    const credential = await this.db().cardProviderCredential.update({
      where: { provider },
      data: { status: CommonStatus.disabled, updatedBy: actor.userId },
    });
    const afterAudit = toCredentialAudit(credential);

    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'api_credential.card_provider.disable',
      objectType: 'card_provider_credentials',
      objectId: credential.id,
      beforeData: beforeAudit,
      afterData: afterAudit,
      changedFields: changedFields(beforeAudit, afterAudit, ['status', 'updatedBy']),
      requestPayload: { provider },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return toCardProviderDto(provider, credential);
  }

  private async getAffiliateAccountOrThrow(affiliateAccountId: string) {
    const account = await this.db().affiliateAccount.findUnique({
      where: { id: affiliateAccountId },
      select: affiliateAccountSelect(),
    });
    if (!account) throw notFound('Affiliate account');
    return account;
  }

  private db(): CredentialPrisma {
    return this.prisma as unknown as CredentialPrisma;
  }
}

function affiliateAccountSelect() {
  return {
    id: true,
    platform: true,
    accountCode: true,
    accountName: true,
    credential: {
      select: {
        id: true,
        affiliateAccountId: true,
        maskedPayload: true,
        status: true,
        createdBy: true,
        updatedBy: true,
        createdAt: true,
        updatedAt: true,
      },
    },
  };
}

function validatePayload(payload: unknown): Record<string, unknown> {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload as Record<string, unknown>).length === 0
  ) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'payload must be a non-empty object.');
  }
  return payload as Record<string, unknown>;
}

function maskPayload(value: unknown): unknown {
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map(maskPayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, maskPayload(nested)]));
  }
  return { type: value === null ? 'null' : typeof value };
}

function maskString(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function assertAffiliatePlatform(platform: string) {
  const normalized = platform.trim().toLowerCase();
  if (!AFFILIATE_PLATFORMS.includes(normalized as (typeof AFFILIATE_PLATFORMS)[number])) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'affiliateAccount.platform must be everflow or cake.');
  }
}

function normalizeCardProvider(providerInput: string): Provider {
  const provider = requireNonBlank(providerInput, 'provider').toLowerCase();
  if (provider === Provider.airwallex || provider === Provider.photonpay) return provider;
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'provider must be airwallex or photonpay.');
}

function toCredentialAudit(credential: CredentialRecord) {
  return {
    id: credential.id,
    maskedPayload: credential.maskedPayload,
    status: credential.status,
    createdBy: credential.createdBy,
    updatedBy: credential.updatedBy,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

function credentialChangedFields(before: ReturnType<typeof toCredentialAudit> | undefined, after: ReturnType<typeof toCredentialAudit>, encryptedChanged: boolean) {
  if (!before) return ['encryptedPayload', 'maskedPayload', 'status', 'createdBy', 'updatedBy'];
  const fields = changedFields(before, after, ['maskedPayload', 'status', 'updatedBy']);
  return encryptedChanged ? ['encryptedPayload', ...fields] : fields;
}

function toAffiliateAccountDto(account: AffiliateAccountRecord) {
  return {
    affiliateAccountId: account.id,
    platform: account.platform,
    accountCode: account.accountCode,
    accountName: account.accountName,
    hasCredential: Boolean(account.credential),
    status: account.credential?.status,
    maskedPayload: account.credential?.maskedPayload ?? null,
    updatedAt: account.credential?.updatedAt ?? null,
  };
}

function toCardProviderDto(provider: Provider, credential: CredentialRecord | null) {
  return {
    provider,
    hasCredential: Boolean(credential),
    status: credential?.status,
    maskedPayload: credential?.maskedPayload ?? null,
    updatedAt: credential?.updatedAt ?? null,
  };
}
