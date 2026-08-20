import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma, Provider, ProviderCardMatchStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { CredentialReaderService } from '../api-credentials/credential-reader.service';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { ERROR_CODES } from '@salary/shared';
import {
  AIRWALLEX_BUSINESS_ACCOUNT_API_VERSION,
  AirwallexClient,
  AirwallexCredentialPayload,
  AirwallexTransactionRecord,
} from '../sync-tasks/airwallex/airwallex-client';
import {
  PhotonPayCardRecord,
  PhotonPayClient,
  PhotonPayCredentialPayload,
} from '../sync-tasks/photonpay/photonpay-client';
import { ProviderRequestError } from '../sync-tasks/provider-request-error';
import {
  EffectiveSubIdMappingReader,
  isUsableEffectiveSubIdMapping,
  resolveEffectiveSubIdMappings,
} from '../sub-id-mappings/effective-sub-id-mappings';

const AIRWALLEX_FIRST_CARD_DATE = new Date('2018-01-01T00:00:00.000Z');
const AIRWALLEX_WINDOW_DAYS = 30;
const PAGE_SIZE = 200;
const MAX_PAGES = 10_000;
const PHOTONPAY_PRODUCTION_CARD_DETAIL_INTERVAL_MS = 500;
const PHOTONPAY_PRODUCTION_RATE_LIMIT_RETRY_MS = 30_000;

type SafeProviderCard = {
  cardId: string;
  cardholderId: string | null;
  email: string | null;
  maskedCardNumber: string | null;
  nickname: string | null;
  providerStatus: string | null;
  sourceCreatedAt: Date | null;
  sourceUpdatedAt: Date | null;
  forcedReasonCode?: string;
};

export type CardInventorySyncResult = {
  provider: Provider;
  status: 'completed' | 'partial' | 'external_blocked' | 'failed';
  discoveredCount: number;
  matchedCount: number;
  unmatchedCount: number;
  conflictCount: number;
  invalidCardCount: number;
  retainedHistoricalCards: true;
  apiVersion?: string;
  mappingDiagnostics?: {
    employeeNotFound: number;
    employeeDisabled: number;
    employeeWithoutSub: number;
    multipleEmployeeEmail: number;
    multipleBusinessSubValues: number;
  };
  connectionDiagnostics?: {
    authenticationRequestCount: number;
    authenticationCacheHitCount: number;
    authenticationRefreshCount: number;
    cardListRequestCount: number;
    cardDetailRequestCount: number;
    cardPages: number;
    cardStatusCounts: Record<string, number>;
    cardOrganizationCounts: Record<string, number>;
    lastAuth: ReturnType<PhotonPayClient['getSafeDiagnostics']>['lastAuth'];
  };
  error?: ReturnType<typeof safeProviderError>;
};

@Injectable()
export class ProviderCardInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialReaderService,
    private readonly airwallex: AirwallexClient,
    private readonly photonpay: PhotonPayClient,
    private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, string> = {}) {
    const provider = parseProvider(query.provider, true);
    const matchStatus = parseMatchStatus(query.matchStatus);
    const items = await this.prisma.providerCard.findMany({
      where: { provider, matchStatus },
      include: { employee: { select: { id: true, employeeCode: true, name: true, email: true, status: true } } },
      orderBy: [{ provider: 'asc' }, { updatedAt: 'desc' }, { cardId: 'asc' }],
    });
    const counts = await this.prisma.providerCard.groupBy({
      by: ['provider', 'matchStatus'], where: provider ? { provider } : undefined, _count: { _all: true },
    });
    return {
      items: items.map((card) => ({
        id: card.id,
        provider: card.provider,
        cardId: card.cardId,
        maskedCardNumber: card.maskedCardNumber,
        nickname: card.nickname,
        providerStatus: card.providerStatus,
        cardholderId: card.cardholderId,
        cardholderEmail: card.cardholderEmailNormalized,
        employeeId: card.employeeId,
        employeeCode: card.employee?.employeeCode ?? null,
        employeeName: card.employee?.name ?? null,
        matchStatus: card.matchStatus,
        unmatchedReasonCode: card.unmatchedReasonCode,
        lastCardSyncedAt: card.lastCardSyncedAt,
        lastTransactionSyncedAt: card.lastTransactionSyncedAt,
        lastTransactionSyncStatus: card.lastTransactionSyncStatus,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
      })),
      summary: Object.fromEntries(counts.map((row) => [`${row.provider}.${row.matchStatus}`, row._count._all])),
    };
  }

  async syncAll(actor: Actor) {
    const results: CardInventorySyncResult[] = [];
    for (const provider of [Provider.airwallex, Provider.photonpay]) {
      let payload: unknown;
      try {
        const credential = await this.credentials.getCardProviderCredentialPayload(provider);
        payload = credential.payload;
        results.push(await this.syncProviderWithPayload(provider, payload));
      } catch (error) {
        results.push(failedResult(provider, error, payload));
      }
    }
    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'provider_card.inventory.sync_all',
      objectType: 'provider_cards',
      afterData: results,
      changedFields: ['providerCards'],
      requestPayload: { providers: [Provider.airwallex, Provider.photonpay] },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return { status: results.every((item) => item.status === 'completed') ? 'completed' : 'partial', results };
  }

  async syncProvider(provider: Provider, actor: Actor) {
    let result: CardInventorySyncResult;
    let payload: unknown;
    try {
      const credential = await this.credentials.getCardProviderCredentialPayload(provider);
      payload = credential.payload;
      result = await this.syncProviderWithPayload(provider, payload);
    } catch (error) {
      result = failedResult(provider, error, payload);
    }
    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'provider_card.inventory.sync',
      objectType: 'provider_cards',
      afterData: result,
      changedFields: ['providerCards'],
      requestPayload: { provider },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return result;
  }

  async syncProviderWithPayload(
    provider: Provider,
    payload: unknown,
    settlementMonth = currentShanghaiSettlementMonth(),
  ): Promise<CardInventorySyncResult> {
    const result = provider === Provider.airwallex
      ? await this.loadAirwallex(parseAirwallexCredential(payload))
      : await this.loadPhotonPay(parsePhotonPayCredential(payload));
    const employees = await this.prisma.employee.findMany({
      select: { id: true, email: true, status: true },
    });
    const effectiveMappings = provider === Provider.photonpay
      ? await resolveEffectiveSubIdMappings(this.prisma as unknown as EffectiveSubIdMappingReader, { settlementMonth })
      : [];
    const mappingsByEmployee = new Map<string, typeof effectiveMappings>();
    for (const mapping of effectiveMappings.filter(isUsableEffectiveSubIdMapping)) {
      const mappings = mappingsByEmployee.get(mapping.employeeId) ?? [];
      mappings.push(mapping);
      mappingsByEmployee.set(mapping.employeeId, mappings);
    }
    let matchedCount = 0;
    let unmatchedCount = 0;
    let conflictCount = 0;
    const mappingDiagnostics = {
      employeeNotFound: 0,
      employeeDisabled: 0,
      employeeWithoutSub: 0,
      multipleEmployeeEmail: 0,
      multipleBusinessSubValues: 0,
    };
    const syncedAt = new Date();
    for (const card of result.cards) {
      const match = matchEmployee(card, employees);
      if (match.status === ProviderCardMatchStatus.matched) matchedCount += 1;
      else if (match.status === ProviderCardMatchStatus.conflict) conflictCount += 1;
      else unmatchedCount += 1;
      if (match.reasonCode === 'EMPLOYEE_NOT_FOUND') mappingDiagnostics.employeeNotFound += 1;
      if (match.reasonCode === 'EMPLOYEE_DISABLED') mappingDiagnostics.employeeDisabled += 1;
      if (match.reasonCode === 'EMPLOYEE_EMAIL_AMBIGUOUS') mappingDiagnostics.multipleEmployeeEmail += 1;
      if (provider === Provider.photonpay && match.employeeId) {
        const businessSubValues = new Set(
          (mappingsByEmployee.get(match.employeeId) ?? [])
            .map((mapping) => mapping.subValue.trim())
            .filter(Boolean),
        );
        if (businessSubValues.size === 0) mappingDiagnostics.employeeWithoutSub += 1;
        else if (businessSubValues.size > 1) mappingDiagnostics.multipleBusinessSubValues += 1;
      }
      await this.prisma.providerCard.upsert({
        where: { provider_cardId: { provider, cardId: card.cardId } },
        update: {
          cardholderId: card.cardholderId,
          cardholderEmailNormalized: normalizeEmail(card.email),
          maskedCardNumber: maskOnly(card.maskedCardNumber),
          nickname: card.nickname,
          providerStatus: card.providerStatus,
          employeeId: match.employeeId,
          matchStatus: match.status,
          unmatchedReasonCode: match.reasonCode,
          lastCardSyncedAt: syncedAt,
          sourceCreatedAt: card.sourceCreatedAt,
          sourceUpdatedAt: card.sourceUpdatedAt,
        },
        create: {
          provider,
          cardId: card.cardId,
          cardholderId: card.cardholderId,
          cardholderEmailNormalized: normalizeEmail(card.email),
          maskedCardNumber: maskOnly(card.maskedCardNumber),
          nickname: card.nickname,
          providerStatus: card.providerStatus,
          employeeId: match.employeeId,
          matchStatus: match.status,
          unmatchedReasonCode: match.reasonCode,
          lastCardSyncedAt: syncedAt,
          sourceCreatedAt: card.sourceCreatedAt,
          sourceUpdatedAt: card.sourceUpdatedAt,
        },
      });
    }
    return {
      provider,
      status: result.partialError || result.invalidCardCount > 0 ? 'partial' : 'completed',
      discoveredCount: result.cards.length + result.invalidCardCount,
      matchedCount,
      unmatchedCount: unmatchedCount + result.invalidCardCount,
      conflictCount,
      invalidCardCount: result.invalidCardCount,
      retainedHistoricalCards: true,
      apiVersion: 'apiVersion' in result && typeof result.apiVersion === 'string' ? result.apiVersion : undefined,
      mappingDiagnostics: provider === Provider.photonpay ? mappingDiagnostics : undefined,
      connectionDiagnostics: 'connectionDiagnostics' in result ? result.connectionDiagnostics : undefined,
      error: result.partialError,
    };
  }

  async resolveSpendOwner(provider: Provider, cardId: string, settlementMonth: Date) {
    const card = await this.prisma.providerCard.findUnique({
      where: { provider_cardId: { provider, cardId } },
      include: { employee: { select: { id: true, status: true } } },
    });
    if (!card || card.matchStatus !== ProviderCardMatchStatus.matched || !card.employeeId || !card.employee) {
      return { ok: false as const, reasonCode: 'CARD_NOT_MAPPED', reasonMessage: `${provider} card is not uniquely mapped to an employee.` };
    }
    if (card.employee.status !== CommonStatus.active) {
      return { ok: false as const, reasonCode: 'EMPLOYEE_DISABLED', reasonMessage: 'The matched employee is disabled.' };
    }
    // ProviderCard is already the canonical, unique provider + cardId -> employee
    // match. Affiliate SUB mappings are independent attribution metadata and may
    // legally contain multiple accounts for the same employee.
    return { ok: true as const, employeeId: card.employeeId };
  }

  async markTransactionSync(provider: Provider, cardId: string, status: string, syncedAt = new Date()) {
    await this.prisma.providerCard.updateMany({
      where: { provider, cardId },
      data: { lastTransactionSyncedAt: syncedAt, lastTransactionSyncStatus: status.slice(0, 64) },
    });
  }

  async markUntouchedTransactionSync(provider: Provider, startedAt: Date, status: string, syncedAt = new Date()) {
    await this.prisma.providerCard.updateMany({
      where: {
        provider,
        OR: [{ lastTransactionSyncedAt: null }, { lastTransactionSyncedAt: { lt: startedAt } }],
      },
      data: { lastTransactionSyncedAt: syncedAt, lastTransactionSyncStatus: status.slice(0, 64) },
    });
  }

  private async loadAirwallex(credential: AirwallexCredentialPayload) {
    const versions = uniqueVersions(credential.apiVersion);
    let selected: string | null | undefined;
    let lastError: unknown;
    for (const version of versions) {
      const candidate = { ...credential, apiVersion: version };
      try {
        await this.airwallex.listCards({ credential: candidate, page: 0, pageSize: 10 });
        selected = version;
        credential = candidate;
        break;
      } catch (error) {
        lastError = error;
        if (!(error instanceof ProviderRequestError) || error.httpStatus !== 400) throw error;
      }
    }
    if (selected === undefined) throw lastError;

    const cardsById = new Map<string, AirwallexTransactionRecord>();
    let invalidCardCount = 0;
    const finalTo = new Date();
    for (let from = new Date(AIRWALLEX_FIRST_CARD_DATE); from <= finalTo;) {
      const to = new Date(Math.min(finalTo.getTime(), from.getTime() + AIRWALLEX_WINDOW_DAYS * 86_400_000 - 1));
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await this.airwallex.listCards({ credential, page, pageSize: PAGE_SIZE, from, to });
        for (const card of response.cards) {
          const id = firstString(card.card_id, card.id);
          if (id) cardsById.set(id, card);
          else invalidCardCount += 1;
        }
        if (!response.hasMore || response.cards.length === 0) break;
        if (page === MAX_PAGES - 1) throw new Error('Airwallex card pagination exceeded the safety limit.');
      }
      from = new Date(to.getTime() + 1);
    }

    const holders = new Map<string, AirwallexTransactionRecord>();
    let partialError: ReturnType<typeof safeProviderError> | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await this.airwallex.listCardholders({ credential, page, pageSize: PAGE_SIZE });
        for (const holder of response.cardholders) {
          const id = firstString(holder.cardholder_id, holder.id);
          if (id) holders.set(id, holder);
        }
        if (!response.hasMore || response.cardholders.length === 0) break;
      }
    } catch (error) {
      partialError = safeProviderError(error, credential.apiVersion);
      partialError.message = redactCredentialValues(partialError.message, [credential.clientId, credential.apiKey]);
    }
    return {
      cards: [...cardsById.values()].flatMap((card) => {
        const normalized = normalizeAirwallexCard(card, holders, Boolean(partialError));
        return normalized ? [normalized] : [];
      }),
      apiVersion: credential.apiVersion ?? 'default',
      partialError,
      invalidCardCount,
    };
  }

  private async loadPhotonPay(credential: PhotonPayCredentialPayload) {
    const diagnosticsBefore = photonPayDiagnostics(this.photonpay);
    const cards: SafeProviderCard[] = [];
    let invalidCardCount = 0;
    let partialError: ReturnType<typeof safeProviderError> | undefined;
    let cardPages = 0;
    let lastCardDetailRequestAt = 0;
    const cardStatusCounts: Record<string, number> = {};
    const cardOrganizationCounts: Record<string, number> = {};
    for (let page = 1; page < MAX_PAGES; page += 1) {
      const response = await this.photonpay.listCards({ credential, page, pageSize: PAGE_SIZE });
      cardPages += 1;
      for (const listed of response.cards) {
        if (!listed.cardId) { invalidCardCount += 1; continue; }
        let detail: PhotonPayCardRecord = listed;
        try {
          if (process.env.NODE_ENV === 'production') {
            const remainingDelay = PHOTONPAY_PRODUCTION_CARD_DETAIL_INTERVAL_MS - (Date.now() - lastCardDetailRequestAt);
            if (remainingDelay > 0) await pause(remainingDelay);
          }
          try {
            lastCardDetailRequestAt = Date.now();
            detail = await this.photonpay.getCardDetail({ credential, cardId: listed.cardId });
          } catch (error) {
            if (process.env.NODE_ENV !== 'production' || !isPhotonPayRateLimit(error)) throw error;
            await pause(PHOTONPAY_PRODUCTION_RATE_LIMIT_RETRY_MS);
            lastCardDetailRequestAt = Date.now();
            detail = await this.photonpay.getCardDetail({ credential, cardId: listed.cardId });
          }
        } catch (error) {
          partialError ??= safeProviderError(error);
          partialError.message = redactCredentialValues(partialError.message, [credential.appId, credential.appSecret]);
          detail = { ...listed, email: null };
        }
        cards.push({
          cardId: listed.cardId,
          cardholderId: detail.cardholderId,
          email: detail.email,
          maskedCardNumber: detail.maskCardNo ?? listed.maskCardNo,
          nickname: detail.nickname ?? listed.nickname,
          providerStatus: detail.cardStatus ?? listed.cardStatus,
          sourceCreatedAt: parseDate(detail.createdAt ?? listed.createdAt),
          sourceUpdatedAt: parseDate(detail.updatedAt ?? listed.updatedAt),
          forcedReasonCode: detail.email ? undefined : partialError ? 'CARDHOLDER_LOOKUP_FAILED' : undefined,
        });
        incrementCount(cardStatusCounts, detail.cardStatus ?? listed.cardStatus ?? 'UNKNOWN');
        incrementCount(cardOrganizationCounts, detail.cardOrganization ?? listed.cardOrganization ?? 'UNKNOWN');
      }
      if (!response.hasMore || response.cards.length === 0) break;
      if (page === MAX_PAGES - 1) throw new Error('PhotonPay card pagination exceeded the safety limit.');
    }
    const diagnosticsAfter = photonPayDiagnostics(this.photonpay);
    return {
      cards,
      partialError,
      invalidCardCount,
      connectionDiagnostics: {
        authenticationRequestCount: diagnosticsAfter.authenticationRequestCount - diagnosticsBefore.authenticationRequestCount,
        authenticationCacheHitCount: diagnosticsAfter.authenticationCacheHitCount - diagnosticsBefore.authenticationCacheHitCount,
        authenticationRefreshCount: diagnosticsAfter.authenticationRefreshCount - diagnosticsBefore.authenticationRefreshCount,
        cardListRequestCount: diagnosticsAfter.cardListRequestCount - diagnosticsBefore.cardListRequestCount,
        cardDetailRequestCount: diagnosticsAfter.cardDetailRequestCount - diagnosticsBefore.cardDetailRequestCount,
        cardPages,
        cardStatusCounts,
        cardOrganizationCounts,
        lastAuth: diagnosticsAfter.lastAuth,
      },
    };
  }
}

function normalizeAirwallexCard(
  card: AirwallexTransactionRecord,
  holders: Map<string, AirwallexTransactionRecord>,
  holderLookupFailed: boolean,
): SafeProviderCard | null {
  const cardId = firstString(card.card_id, card.id);
  if (!cardId) return null;
  const cardholderId = firstString(card.cardholder_id, objectField(card.cardholder, 'cardholder_id'), objectField(card.cardholder, 'id'));
  const holder = cardholderId ? holders.get(cardholderId) : undefined;
  const additional = Array.isArray(card.additional_cardholder_ids)
    ? card.additional_cardholder_ids.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  return {
    cardId,
    cardholderId,
    email: firstString(holder?.email, objectField(card.cardholder, 'email')),
    maskedCardNumber: maskOnly(firstString(card.card_number, card.masked_card_number, card.last4)),
    nickname: firstString(card.nick_name, card.nickname),
    providerStatus: firstString(card.card_status, card.status),
    sourceCreatedAt: parseDate(card.created_at),
    sourceUpdatedAt: parseDate(card.updated_at),
    forcedReasonCode: additional.some((id) => id !== cardholderId)
      ? 'MULTIPLE_CARDHOLDERS'
      : holderLookupFailed
        ? 'CARDHOLDER_LOOKUP_FAILED'
        : undefined,
  };
}

function matchEmployee(
  card: SafeProviderCard,
  employees: Array<{ id: string; email: string | null; status: CommonStatus }>,
) {
  if (card.forcedReasonCode) {
    return {
      employeeId: null,
      status: card.forcedReasonCode === 'MULTIPLE_CARDHOLDERS' ? ProviderCardMatchStatus.conflict : ProviderCardMatchStatus.unmatched,
      reasonCode: card.forcedReasonCode,
    };
  }
  const email = normalizeEmail(card.email);
  if (!email) return { employeeId: null, status: ProviderCardMatchStatus.unmatched, reasonCode: 'CARDHOLDER_EMAIL_MISSING' };
  if (!isValidEmail(email)) return { employeeId: null, status: ProviderCardMatchStatus.unmatched, reasonCode: 'CARDHOLDER_EMAIL_INVALID' };
  const exact = employees.filter((employee) => normalizeEmail(employee.email) === email);
  if (exact.length > 1) return { employeeId: null, status: ProviderCardMatchStatus.conflict, reasonCode: 'EMPLOYEE_EMAIL_AMBIGUOUS' };
  const active = exact.filter((employee) => employee.status === CommonStatus.active);
  if (active.length === 0 && exact.length > 0) return { employeeId: null, status: ProviderCardMatchStatus.unmatched, reasonCode: 'EMPLOYEE_DISABLED' };
  if (active.length === 0) return { employeeId: null, status: ProviderCardMatchStatus.unmatched, reasonCode: 'EMPLOYEE_NOT_FOUND' };
  return { employeeId: active[0].id, status: ProviderCardMatchStatus.matched, reasonCode: null };
}

function parseAirwallexCredential(payload: unknown): AirwallexCredentialPayload {
  const record = objectPayload(payload, 'Airwallex');
  const clientId = firstString(record.clientId, record.client_id);
  const apiKey = firstString(record.apiKey, record.api_key, record.secret);
  if (!clientId || !apiKey) throw new Error('Airwallex credential requires clientId and apiKey.');
  return {
    clientId, apiKey,
    baseUrl: firstString(record.baseUrl, record.base_url) ?? undefined,
    transactionsPath: firstString(record.transactionsPath, record.transactions_path) ?? undefined,
    cardsPath: firstString(record.cardsPath, record.cards_path) ?? undefined,
    cardholdersPath: firstString(record.cardholdersPath, record.cardholders_path) ?? undefined,
    apiVersion: firstString(record.apiVersion, record.api_version) ?? undefined,
    settlementDelayDays: settlementDelay(record.settlementDelayDays),
  };
}

export function parsePhotonPayCredential(payload: unknown): PhotonPayCredentialPayload {
  const record = objectPayload(payload, 'PhotonPay');
  const appId = firstString(record.appId, record.app_id, record.apiKey);
  const appSecret = firstString(record.appSecret, record.app_secret, record.secret);
  if (!appId || !appSecret) throw new Error('PhotonPay credential requires appId and appSecret.');
  return {
    appId, appSecret,
    baseUrl: firstString(record.baseUrl, record.base_url) ?? undefined,
    tokenPath: firstString(record.tokenPath, record.token_path) ?? undefined,
    cardsPath: firstString(record.cardsPath, record.cards_path) ?? undefined,
    cardDetailPath: firstString(record.cardDetailPath, record.card_detail_path) ?? undefined,
    transactionsPath: firstString(record.transactionsPath, record.transactions_path) ?? undefined,
    settlementDelayDays: settlementDelay(record.settlementDelayDays),
  };
}

function failedResult(provider: Provider, error: unknown, payload?: unknown): CardInventorySyncResult {
  const details = safeProviderError(error);
  details.message = redactCredentialValues(details.message, credentialStrings(payload));
  const externalBlocked = error instanceof ProviderRequestError && ['CREDENTIAL_INVALID', 'BUSINESS_REJECTED'].includes(error.category);
  return {
    provider,
    status: externalBlocked ? 'external_blocked' : 'failed',
    discoveredCount: 0,
    matchedCount: 0,
    unmatchedCount: 0,
    conflictCount: 0,
    invalidCardCount: 0,
    retainedHistoricalCards: true,
    error: details,
  };
}

function credentialStrings(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Object.values(payload as Record<string, unknown>).filter((value): value is string => typeof value === 'string' && Boolean(value));
}

function redactCredentialValues(message: string, values: string[]): string {
  return values.reduce((sanitized, value) => value ? sanitized.split(value).join('[REDACTED]') : sanitized, message);
}

export function safeProviderError(error: unknown, apiVersion?: string | null) {
  if (error instanceof ProviderRequestError) {
    return {
      category: error.category,
      httpStatus: error.httpStatus ?? null,
      code: error.providerCode ?? null,
      message: error.providerMessage ?? error.message,
      requestId: error.requestId ?? null,
      apiVersion: error.apiVersion ?? apiVersion ?? null,
    };
  }
  return { category: 'UNKNOWN', httpStatus: null, code: null, message: error instanceof Error ? error.message : 'Provider request failed.', requestId: null, apiVersion: apiVersion ?? null };
}

function uniqueVersions(configured: string | null | undefined): Array<string | null> {
  const candidates = configured ? [configured, AIRWALLEX_BUSINESS_ACCOUNT_API_VERSION, null] : [AIRWALLEX_BUSINESS_ACCOUNT_API_VERSION, null];
  return [...new Set(candidates)];
}

function parseProvider(value: string | undefined, optional = false): Provider | undefined {
  if (!value && optional) return undefined;
  if (value === Provider.airwallex || value === Provider.photonpay) return value;
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'provider must be airwallex or photonpay.');
}

function parseMatchStatus(value: string | undefined): ProviderCardMatchStatus | undefined {
  if (!value) return undefined;
  if (Object.values(ProviderCardMatchStatus).includes(value as ProviderCardMatchStatus)) return value as ProviderCardMatchStatus;
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'matchStatus is invalid.');
}

function objectPayload(payload: unknown, provider: string): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`${provider} credential payload is invalid.`);
  return payload as Record<string, unknown>;
}

function objectField(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function settlementDelay(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 31 ? parsed : undefined;
}

function normalizeEmail(value: string | null): string | null {
  const email = value?.trim().toLowerCase() ?? '';
  return email ? email.slice(0, 255) : null;
}

function currentShanghaiSettlementMonth(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1));
}

function photonPayDiagnostics(client: PhotonPayClient): ReturnType<PhotonPayClient['getSafeDiagnostics']> {
  if (typeof client.getSafeDiagnostics === 'function') return client.getSafeDiagnostics();
  return {
    authenticationRequestCount: 0,
    authenticationCacheHitCount: 0,
    authenticationRefreshCount: 0,
    cardListRequestCount: 0,
    cardDetailRequestCount: 0,
    transactionListRequestCount: 0,
    lastAuth: null,
  };
}

function isPhotonPayRateLimit(error: unknown) {
  if (!(error instanceof ProviderRequestError)) return false;
  return error.httpStatus === 429
    || error.providerCode === '1008'
    || /too many requests|rate limit/i.test(`${error.message} ${error.providerMessage ?? ''}`);
}

function pause(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function incrementCount(counts: Record<string, number>, value: string) {
  const key = value.trim() || 'UNKNOWN';
  counts[key] = (counts[key] ?? 0) + 1;
}

function isValidEmail(value: string): boolean {
  return value.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function maskOnly(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `****${digits.slice(-4)}` : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
