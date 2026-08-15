import { Injectable } from '@nestjs/common';
import { Prisma, Provider, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../../common/app-error';
import { ProviderCardInventoryService, safeProviderError } from '../../card-bindings/provider-card-inventory.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncUnmatchedEventsService } from '../../sync-unmatched-events/sync-unmatched-events.service';
import { SyncAdapter, SyncAdapterContext, SyncAdapterResult } from '../sync-adapter';
import { providerErrorCategory } from '../provider-request-error';
import { AirwallexClient, AirwallexCredentialPayload, AirwallexTransactionRecord } from './airwallex-client';

const PAGE_SIZE = 100;
const DEFAULT_SETTLEMENT_DELAY_DAYS = 10;
const MAX_SETTLEMENT_DELAY_DAYS = 31;

type NormalizedAirwallexTransaction = {
  externalEventId: string | null;
  cardId: string | null;
  cardLast4: string | null;
  cardEmail: string | null;
  transactionAt: Date | null;
  amount: Prisma.Decimal;
  currency: string | null;
  settledAt: Date | null;
  sourceStatus: string | null;
  transactionType: string | null;
  fundDirection: string | null;
  sourceUpdatedAt: Date | null;
};

type AirwallexAdapterPrisma = {
  cardSpendEvent: {
    upsert(args: unknown): Promise<unknown>;
  };
};

@Injectable()
export class AirwallexCardSyncAdapter implements SyncAdapter {
  readonly adapterKey = 'card_spend.airwallex';

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AirwallexClient,
    private readonly unmatchedEvents: SyncUnmatchedEventsService,
    private readonly inventory: ProviderCardInventoryService,
  ) {}

  async execute(context: SyncAdapterContext): Promise<SyncAdapterResult> {
    this.assertContext(context);
    const credential = parseCredentialPayload(context.credential.payload);
    const window = getAirwallexRequestAndSettlementWindows(context.settlementMonth, credential.settlementDelayDays ?? DEFAULT_SETTLEMENT_DELAY_DAYS);

    let successCount = 0;
    let failedCount = 0;
    const transactionSyncStartedAt = new Date();
    let page = 0;
    let cardInventory: Awaited<ReturnType<ProviderCardInventoryService['syncProviderWithPayload']>> | null = null;

    try {
      cardInventory = await this.inventory.syncProviderWithPayload(Provider.airwallex, context.credential.payload);
      while (true) {
        const response = await this.client.listCardTransactions({
          credential,
          from: window.requestFromCreatedDate,
          to: window.requestToCreatedDate,
          page,
          pageSize: PAGE_SIZE,
        });

        for (const raw of response.transactions) {
          const record = normalizeAirwallexTransaction(raw);
          if (!isSettled(record)) continue;
          if (!record.transactionAt) {
            await this.recordUnmatchedCardSpend(record, context, 'UNKNOWN', 'Airwallex settled card transaction is missing transactionAt.');
            failedCount += 1;
            continue;
          }
          if (!isInsideSettlementWindow(record.transactionAt, window)) continue;

          const result = await this.upsertCardSpendEvent(record, context);
          if (result) successCount += 1;
          else failedCount += 1;
        }

        if (!response.hasMore || response.transactions.length === 0 || response.nextPage === null) break;
        page = response.nextPage;
      }
    } catch (error) {
      failedCount += 1;
      await this.inventory.markUntouchedTransactionSync(Provider.airwallex, transactionSyncStartedAt, `failed:${providerErrorCategory(error)}`);
      const errorMessage = sanitizeErrorMessage(error instanceof Error ? error.message : 'Airwallex card spend request failed.', credential);
      const providerError = safeProviderError(error, credential.apiVersion);
      providerError.message = sanitizeErrorMessage(providerError.message, credential);
      return { ...this.result('failed', successCount, failedCount, window, errorMessage, context, cardInventory, providerError), errorCategory: providerErrorCategory(error) };
    }

    const status = failedCount === 0 ? 'completed' : 'failed';
    await this.inventory.markUntouchedTransactionSync(Provider.airwallex, transactionSyncStartedAt, 'completed:no_transactions');
    const message = `Airwallex card spend sync finished: successCount=${successCount}, failedCount=${failedCount}.`;
    return this.result(status, successCount, failedCount, window, message, context, cardInventory);
  }

  private result(
    status: 'completed' | 'failed',
    successCount: number,
    failedCount: number,
    window: ReturnType<typeof getAirwallexGmt8SettlementMonthWindow>,
    message: string,
    context: SyncAdapterContext,
    cardInventory: Awaited<ReturnType<ProviderCardInventoryService['syncProviderWithPayload']>> | null,
    providerError: ReturnType<typeof safeProviderError> | null = null,
  ): SyncAdapterResult {
    return {
      status,
      successCount,
      failedCount,
      message,
      errorMessage: status === 'failed' ? message : null,
      resultPayload: {
        adapterKey: this.adapterKey,
        provider: Provider.airwallex,
        pulledThirdPartyData: cardInventory !== null || successCount > 0,
        successCount,
        failedCount,
        cardInventory,
        providerError,
        settlementMonth: context.settlementMonth.toISOString().slice(0, 10),
        requestWindow: {
          fromCreatedDate: window.requestFromCreatedDate.toISOString(),
          toCreatedDate: window.requestToCreatedDate.toISOString(),
        },
        settlementWindow: {
          startInclusiveUtc: window.settlementStartInclusiveUtc.toISOString(),
          endExclusiveUtc: window.settlementEndExclusiveUtc.toISOString(),
          timezone: 'GMT+8',
        },
      },
    };
  }

  private async upsertCardSpendEvent(record: NormalizedAirwallexTransaction, context: SyncAdapterContext): Promise<boolean> {
    if (!record.externalEventId) {
      await this.recordUnmatchedCardSpend(record, context, 'UNKNOWN', 'Airwallex settled card transaction is missing external event id.');
      return false;
    }
    if (!record.cardId) {
      await this.recordUnmatchedCardSpend(record, context, 'CARD_ID_MISSING', 'Airwallex settled card transaction is missing cardId.');
      return false;
    }
    if (!record.transactionAt) {
      await this.recordUnmatchedCardSpend(record, context, 'UNKNOWN', 'Airwallex settled card transaction is missing transactionAt.');
      return false;
    }
    if (record.currency !== 'USD') {
      await this.recordUnmatchedCardSpend(record, context, 'INVALID_CURRENCY', 'Airwallex settled card transaction currency is not USD.');
      return false;
    }

    const ownership = await this.inventory.resolveSpendOwner(Provider.airwallex, record.cardId, context.settlementMonth);
    if (!ownership.ok) {
      await this.recordUnmatchedCardSpend(record, context, ownership.reasonCode, ownership.reasonMessage);
      await this.inventory.markTransactionSync(Provider.airwallex, record.cardId, `unmatched:${ownership.reasonCode}`);
      return false;
    }

    const safeRawData = buildAirwallexRawSafeData(record);

    await this.db().cardSpendEvent.upsert({
      where: { provider_externalEventId: { provider: Provider.airwallex, externalEventId: record.externalEventId } },
      update: {
        settlementMonth: context.settlementMonth,
        cardId: record.cardId,
        employeeId: ownership.employeeId,
        transactionAt: record.transactionAt,
        amount: record.amount,
        currency: record.currency,
        spendUsd: record.amount,
        settledAt: record.settledAt,
        sourceStatus: record.sourceStatus,
        sourceUpdatedAt: record.sourceUpdatedAt,
        rawData: safeRawData,
        status: 'confirmed',
        importedBy: context.requestedBy,
      },
      create: {
        provider: Provider.airwallex,
        externalEventId: record.externalEventId,
        settlementMonth: context.settlementMonth,
        cardId: record.cardId,
        employeeId: ownership.employeeId,
        transactionAt: record.transactionAt,
        amount: record.amount,
        currency: record.currency,
        spendUsd: record.amount,
        settledAt: record.settledAt,
        sourceStatus: record.sourceStatus,
        sourceUpdatedAt: record.sourceUpdatedAt,
        rawData: safeRawData,
        status: 'confirmed',
        importedBy: context.requestedBy,
      },
    });
    await this.unmatchedEvents.resolveAfterSuccessfulImport({
      settlementMonth: context.settlementMonth,
      sourceType: SyncTaskSourceType.card_spend,
      taskType: SyncTaskType.airwallex_card,
      provider: Provider.airwallex,
      thirdPartyEventId: record.externalEventId,
      cardId: record.cardId,
      employeeId: ownership.employeeId,
      resolvedBy: context.requestedBy,
    });
    await this.inventory.markTransactionSync(Provider.airwallex, record.cardId, 'completed');
    return true;
  }

  private async recordUnmatchedCardSpend(
    record: NormalizedAirwallexTransaction,
    context: SyncAdapterContext,
    reasonCode: string,
    reasonMessage: string,
  ) {
    await this.unmatchedEvents.recordUnmatchedEvent({
      settlementMonth: context.settlementMonth,
      sourceType: SyncTaskSourceType.card_spend,
      taskType: SyncTaskType.airwallex_card,
      provider: Provider.airwallex,
      syncTaskId: context.taskId,
      thirdPartyEventId: record.externalEventId,
      reasonCode,
      reasonMessage,
      cardId: record.cardId,
      cardLast4: record.cardLast4,
      cardEmail: record.cardEmail,
      amountUsd: record.currency === 'USD' ? record.amount : null,
      currency: record.currency,
      occurredAt: record.transactionAt,
      rawSafeData: buildAirwallexRawSafeData(record),
    });
  }

  private assertContext(context: SyncAdapterContext) {
    if (context.sourceType !== SyncTaskSourceType.card_spend || context.taskType !== SyncTaskType.airwallex_card) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Airwallex adapter only supports airwallex_card sync tasks.');
    }
    if (context.platform !== SyncTaskPlatform.airwallex || context.provider !== Provider.airwallex) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'card_spend provider/platform must be airwallex.');
    }
  }

  private db(): AirwallexAdapterPrisma {
    return this.prisma as unknown as AirwallexAdapterPrisma;
  }
}

export function getAirwallexGmt8SettlementMonthWindow(settlementMonth: Date) {
  return getAirwallexRequestAndSettlementWindows(settlementMonth, DEFAULT_SETTLEMENT_DELAY_DAYS);
}

export function getAirwallexRequestAndSettlementWindows(settlementMonth: Date, settlementDelayDays: number) {
  const settlementStartInclusiveUtc = new Date(Date.UTC(settlementMonth.getUTCFullYear(), settlementMonth.getUTCMonth(), 1, -8, 0, 0, 0));
  const settlementEndExclusiveUtc = new Date(Date.UTC(settlementMonth.getUTCFullYear(), settlementMonth.getUTCMonth() + 1, 1, -8, 0, 0, 0));
  const requestToCreatedDate = new Date(settlementEndExclusiveUtc.getTime() + settlementDelayDays * 24 * 60 * 60 * 1000);

  return {
    settlementStartInclusiveUtc,
    settlementEndExclusiveUtc,
    requestFromCreatedDate: settlementStartInclusiveUtc,
    requestToCreatedDate,
    settlementDelayDays,
  };
}

export function normalizeAirwallexTransaction(raw: AirwallexTransactionRecord): NormalizedAirwallexTransaction {
  const amount = firstValue(raw.billing_amount, raw.transaction_amount, raw.amount, raw.settlement_amount);
  const transactionType = firstNonBlank(raw.transaction_type, raw.transactionType);
  const fundDirection = firstNonBlank(raw.fund_direction, raw.fundDirection);
  const unsignedAmount = new Prisma.Decimal(typeof amount === 'number' || typeof amount === 'string' ? amount : 0).abs();
  const isCredit = normalizeCode(fundDirection) === 'CREDIT' || ['REFUND', 'REVERSAL', 'REVERSED'].includes(normalizeCode(transactionType) ?? '');
  return {
    externalEventId: firstNonBlank(raw.id, raw.transaction_id, raw.transactionId),
    cardId: firstNonBlank(raw.card_id, raw.cardId, recordField(raw.card, 'id'), recordField(raw.card, 'card_id')),
    cardLast4: firstNonBlank(raw.cardLast4, raw.card_last4, raw.last4, recordField(raw.card, 'last4'), recordField(raw.card, 'cardLast4'), recordField(raw.card, 'card_last4')),
    cardEmail: firstNonBlank(raw.cardEmail, raw.card_email, raw.email, recordField(raw.card, 'email'), recordField(raw.card, 'cardEmail'), recordField(raw.card, 'card_email')),
    transactionAt: parseDate(firstValue(raw.transaction_date, raw.transactionDate, raw.transaction_at, raw.transactionAt)),
    amount: isCredit ? unsignedAmount.negated() : unsignedAmount,
    currency: firstNonBlank(raw.billing_currency, raw.transaction_currency, raw.currency, raw.settlement_currency)?.toUpperCase() ?? null,
    settledAt: parseDate(firstValue(raw.settled_at, raw.settledAt, raw.posted_date, raw.postedDate)),
    sourceStatus: firstNonBlank(raw.status, raw.transaction_status, raw.transactionStatus),
    transactionType,
    fundDirection,
    sourceUpdatedAt: parseDate(firstValue(raw.updated_at, raw.updatedAt)),
  };
}

function recordField(value: unknown, field: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[field] : undefined;
}

function parseCredentialPayload(payload: unknown): AirwallexCredentialPayload {
  if (!payload || typeof payload !== 'object') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Airwallex credential payload is required.');
  }
  const record = payload as Record<string, unknown>;
  const clientId = asNonBlankString(record.clientId) ?? asNonBlankString(record.client_id);
  const apiKey = asNonBlankString(record.apiKey) ?? asNonBlankString(record.api_key) ?? asNonBlankString(record.secret);
  if (!clientId) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Airwallex credential clientId is required.');
  if (!apiKey) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Airwallex credential apiKey is required.');

  return {
    clientId,
    apiKey,
    baseUrl: asNonBlankString(record.baseUrl) ?? asNonBlankString(record.base_url) ?? undefined,
    transactionsPath: asNonBlankString(record.transactionsPath) ?? asNonBlankString(record.transactions_path) ?? undefined,
    cardsPath: asNonBlankString(record.cardsPath) ?? asNonBlankString(record.cards_path) ?? undefined,
    cardholdersPath: asNonBlankString(record.cardholdersPath) ?? asNonBlankString(record.cardholders_path) ?? undefined,
    apiVersion: asNonBlankString(record.apiVersion) ?? asNonBlankString(record.api_version) ?? undefined,
    settlementDelayDays: parseSettlementDelayDays(record.settlementDelayDays),
  };
}

function isSettled(record: NormalizedAirwallexTransaction): boolean {
  const transactionType = normalizeCode(record.transactionType);
  return normalizeCode(record.sourceStatus) === 'CLEARED' || transactionType === 'CLEARING' || transactionType === 'REFUND';
}

function isInsideSettlementWindow(date: Date | null, window: ReturnType<typeof getAirwallexGmt8SettlementMonthWindow>): boolean {
  return !!date && date >= window.settlementStartInclusiveUtc && date < window.settlementEndExclusiveUtc;
}

function firstNonBlank(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = asNonBlankString(value);
    if (normalized) return normalized;
  }
  return null;
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function asNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeCode(value: string | null): string | null {
  return value?.trim().toUpperCase() ?? null;
}

function parseSettlementDelayDays(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_SETTLEMENT_DELAY_DAYS;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_SETTLEMENT_DELAY_DAYS) return DEFAULT_SETTLEMENT_DELAY_DAYS;
  return parsed;
}

function parseDate(value: unknown): Date | null {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildAirwallexRawSafeData(record: NormalizedAirwallexTransaction): Prisma.InputJsonObject {
  return {
    transactionId: record.externalEventId,
    cardId: record.cardId,
    cardLast4: record.cardLast4,
    cardEmail: record.cardEmail,
    status: record.sourceStatus,
    sourceStatus: record.transactionType,
    fundDirection: record.fundDirection,
    amount: record.amount.toString(),
    currency: record.currency,
    transactionAt: record.transactionAt?.toISOString(),
    settledAt: record.settledAt?.toISOString(),
  };
}

function sanitizeErrorMessage(message: string, credential: AirwallexCredentialPayload): string {
  return [credential.clientId, credential.apiKey].reduce((sanitized, secret) => sanitized.split(secret).join('[REDACTED]'), message);
}
