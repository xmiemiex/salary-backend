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
const PHOTONPAY_PRODUCTION_BASE_URL = 'https://x-api.photonpay.com';
const PHOTONPAY_PRODUCTION_PATHS = {
  tokenPath: '/oauth2/token/accessToken',
  cardsPath: '/vcc/openApi/v4/pagingVccCard',
  cardDetailPath: '/vcc/openApi/v4/getCardDetail',
  transactionsPath: '/vcc/openApi/v4/pagingVccTradeOrder',
} as const;

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
    const account = await this.getAffiliateAccountOrThrow(affiliateAccountId);
    assertAffiliatePlatform(account.platform);
    const payload = validateAffiliateCredentialPayload(account, input?.payload);
    const maskedPayload = maskAffiliatePayload(payload);

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
    const payload = provider === Provider.airwallex
      ? validateAirwallexCredentialPayload(input?.payload)
      : validatePhotonPayCredentialPayload(input?.payload);
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

function validateAffiliateCredentialPayload(account: AffiliateAccountRecord, payloadInput: unknown): Record<string, string> {
  const payload = validatePayload(payloadInput);
  if ('affiliateId' in payload || 'affiliate_id' in payload) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      'Affiliate ID is read-only and comes from affiliateAccount.accountCode.',
    );
  }

  const apiKey = requiredString(payload.apiKey, 'apiKey');
  const platform = account.platform.toLowerCase();
  if (platform === 'cake') {
    const baseUrl = validateHttpsUrl(requiredString(payload.baseUrl, 'baseUrl'), 'baseUrl');
    const conversionsPath = optionalString(payload.conversionsPath, 'conversionsPath');
    rejectUnexpectedKeys(payload, ['apiKey', 'baseUrl', 'conversionsPath']);
    return {
      apiKey,
      baseUrl,
      ...(conversionsPath ? { conversionsPath } : {}),
    };
  }

  const baseUrl = optionalString(payload.baseUrl, 'baseUrl');
  rejectUnexpectedKeys(payload, ['apiKey', 'baseUrl']);
  return {
    apiKey,
    ...(baseUrl ? { baseUrl: validateHttpsUrl(baseUrl, 'baseUrl') } : {}),
  };
}

function validateAirwallexCredentialPayload(payloadInput: unknown): Record<string, unknown> {
  const payload = validatePayload(payloadInput);
  const clientId = requiredString(payload.clientId ?? payload.client_id, 'clientId');
  const apiKey = requiredString(payload.apiKey ?? payload.api_key ?? payload.secret, 'apiKey');
  const baseUrl = optionalString(payload.baseUrl ?? payload.base_url, 'baseUrl');
  const transactionsPath = optionalApiPath(payload.transactionsPath ?? payload.transactions_path, 'transactionsPath');
  const cardsPath = optionalApiPath(payload.cardsPath ?? payload.cards_path, 'cardsPath');
  const cardholdersPath = optionalApiPath(payload.cardholdersPath ?? payload.cardholders_path, 'cardholdersPath');
  const apiVersion = optionalString(payload.apiVersion ?? payload.api_version, 'apiVersion');
  if (apiVersion && !/^\d{4}-\d{2}-\d{2}$/.test(apiVersion)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'apiVersion must use YYYY-MM-DD format.');
  }
  const settlementDelayDays = optionalInteger(payload.settlementDelayDays, 'settlementDelayDays', 0, 31);
  rejectUnexpectedKeys(payload, [
    'clientId', 'client_id', 'apiKey', 'api_key', 'secret', 'baseUrl', 'base_url',
    'transactionsPath', 'transactions_path', 'cardsPath', 'cards_path',
    'cardholdersPath', 'cardholders_path', 'apiVersion', 'api_version', 'settlementDelayDays',
  ]);
  return {
    clientId,
    apiKey,
    ...(baseUrl ? { baseUrl: validateHttpsUrl(baseUrl, 'baseUrl') } : {}),
    ...(transactionsPath ? { transactionsPath } : {}),
    ...(cardsPath ? { cardsPath } : {}),
    ...(cardholdersPath ? { cardholdersPath } : {}),
    ...(apiVersion ? { apiVersion } : {}),
    ...(settlementDelayDays !== undefined ? { settlementDelayDays } : {}),
  };
}

function validatePhotonPayCredentialPayload(payloadInput: unknown): Record<string, unknown> {
  const payload = validatePayload(payloadInput);
  const appId = requiredString(payload.appId ?? payload.app_id, 'appId');
  const appSecret = requiredString(payload.appSecret ?? payload.app_secret, 'appSecret');
  const baseUrl = validatePhotonPayProductionBaseUrl(payload.baseUrl ?? payload.base_url);
  const tokenPath = validatePhotonPayProductionPath(payload.tokenPath ?? payload.token_path, 'tokenPath');
  const cardsPath = validatePhotonPayProductionPath(payload.cardsPath ?? payload.cards_path, 'cardsPath');
  const cardDetailPath = validatePhotonPayProductionPath(payload.cardDetailPath ?? payload.card_detail_path, 'cardDetailPath');
  const transactionsPath = validatePhotonPayProductionPath(payload.transactionsPath ?? payload.transactions_path, 'transactionsPath');
  const settlementDelayDays = optionalInteger(payload.settlementDelayDays, 'settlementDelayDays', 0, 31);
  rejectUnexpectedKeys(payload, [
    'appId', 'app_id', 'appSecret', 'app_secret', 'baseUrl', 'base_url',
    'tokenPath', 'token_path', 'cardsPath', 'cards_path', 'cardDetailPath', 'card_detail_path',
    'transactionsPath', 'transactions_path', 'settlementDelayDays',
  ]);
  return {
    appId,
    appSecret,
    baseUrl,
    tokenPath,
    cardsPath,
    cardDetailPath,
    transactionsPath,
    ...(settlementDelayDays !== undefined ? { settlementDelayDays } : {}),
  };
}

function validatePhotonPayProductionBaseUrl(value: unknown): string {
  const configured = optionalString(value, 'baseUrl');
  const normalized = validateHttpsUrl(configured ?? PHOTONPAY_PRODUCTION_BASE_URL, 'baseUrl');
  if (normalized !== PHOTONPAY_PRODUCTION_BASE_URL) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'PhotonPay production credentials require the official production API host.');
  }
  return PHOTONPAY_PRODUCTION_BASE_URL;
}

function validatePhotonPayProductionPath(
  value: unknown,
  field: keyof typeof PHOTONPAY_PRODUCTION_PATHS,
): string {
  const expected = PHOTONPAY_PRODUCTION_PATHS[field];
  const configured = optionalApiPath(value, field);
  if (configured && configured !== expected) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `PhotonPay production ${field} is not allowlisted.`);
  }
  return expected;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a non-blank string when provided.`);
  }
  return value.trim();
}

function optionalApiPath(value: unknown, field: string): string | undefined {
  const path = optionalString(value, field);
  if (!path) return undefined;
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be an absolute API path on the configured provider host.`);
  }
  return path;
}

function optionalInteger(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function validateHttpsUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a credential-free HTTPS URL.`);
  }
  return value.replace(/\/+$/, '');
}

function rejectUnexpectedKeys(payload: Record<string, unknown>, allowed: string[]) {
  const unexpected = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Unsupported credential field(s): ${unexpected.join(', ')}.`);
  }
}

function maskAffiliatePayload(value: unknown, parentKey = ''): unknown {
  if (typeof value === 'string') return isSecretKey(parentKey) ? maskString(value) : value;
  if (Array.isArray(value)) return value.map((child) => maskAffiliatePayload(child, parentKey));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, maskAffiliatePayload(nested, key)]),
    );
  }
  return { type: value === null ? 'null' : typeof value };
}

function maskPayload(value: unknown): unknown {
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map(maskPayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, maskPayload(nested)]),
    );
  }
  return { type: value === null ? 'null' : typeof value };
}

function isSecretKey(key: string): boolean {
  return /api.?key|secret|token|password|authorization/i.test(key);
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
  const platform = account.platform.toLowerCase();
  const maskedPayload =
    account.credential?.maskedPayload && typeof account.credential.maskedPayload === 'object'
      ? Object.fromEntries(
          Object.entries(account.credential.maskedPayload as Record<string, unknown>).filter(
            ([key]) => key !== 'affiliateId' && key !== 'affiliate_id',
          ),
        )
      : account.credential?.maskedPayload ?? null;
  return {
    affiliateAccountId: account.id,
    platform,
    accountCode: account.accountCode,
    accountName: account.accountName,
    affiliateId: platform === 'cake' ? account.accountCode : null,
    hasCredential: Boolean(account.credential),
    status: account.credential?.status,
    maskedPayload,
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
