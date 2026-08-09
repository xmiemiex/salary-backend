import { Injectable } from '@nestjs/common';
import { Prisma, Provider, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../../common/app-error';
import { parsePhotonPayCredential, ProviderCardInventoryService, safeProviderError } from '../../card-bindings/provider-card-inventory.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncUnmatchedEventsService } from '../../sync-unmatched-events/sync-unmatched-events.service';
import { SyncAdapter, SyncAdapterContext, SyncAdapterResult } from '../sync-adapter';
import { providerErrorCategory } from '../provider-request-error';
import { PhotonPayClient, PhotonPayCredentialPayload, PhotonPayTransactionRecord } from './photonpay-client';

const PAGE_SIZE = 200;
const DEFAULT_SETTLEMENT_DELAY_DAYS = 10;
const MAX_SETTLEMENT_DELAY_DAYS = 31;

type NormalizedPhotonPayTransaction = {
  externalEventId: string | null;
  cardId: string | null;
  cardLast4: string | null;
  cardEmail: string | null;
  transactionAt: Date | null;
  amount: Prisma.Decimal;
  currency: string | null;
  settledAt: Date | null;
  sourceStatus: string | null;
  settleStatus: string | null;
  transactionStatus: string | null;
  transactionType: string | null;
  sourceUpdatedAt: Date | null;
};

type PhotonPayAdapterPrisma = {
  cardSpendEvent: {
    upsert(args: unknown): Promise<unknown>;
  };
};

@Injectable()
export class PhotonPayCardSyncAdapter implements SyncAdapter {
  readonly adapterKey = 'card_spend.photonpay';

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: PhotonPayClient,
    private readonly unmatchedEvents: SyncUnmatchedEventsService,
    private readonly inventory: ProviderCardInventoryService,
  ) {}

  async execute(context: SyncAdapterContext): Promise<SyncAdapterResult> {
    this.assertContext(context);
    const credential = parsePhotonPayCredential(context.credential.payload);
    const window = getPhotonPayRequestAndSettlementWindows(context.settlementMonth, credential.settlementDelayDays ?? DEFAULT_SETTLEMENT_DELAY_DAYS);

    let successCount = 0;
    let failedCount = 0;
    const transactionSyncStartedAt = new Date();
    let page = 1;
    let cardInventory: Awaited<ReturnType<ProviderCardInventoryService['syncProviderWithPayload']>> | null = null;

    try {
      cardInventory = await this.inventory.syncProviderWithPayload(Provider.photonpay, context.credential.payload);
      while (true) {
        const response = await this.client.listCardTransactions({
          credential,
          from: window.requestFrom,
          to: window.requestTo,
          page,
          pageSize: PAGE_SIZE,
        });

        for (const raw of response.transactions) {
          const record = normalizePhotonPayTransaction(raw);
          if (!isSettled(record)) continue;
          if (!record.transactionAt) {
            await this.recordUnmatchedCardSpend(record, context, 'UNKNOWN', 'PhotonPay settled transaction is missing transactionAt.');
            failedCount += 1;
            continue;
          }
          if (!isInsideSettlementWindow(record.transactionAt, window)) continue;

          const result = await this.upsertCardSpendEvent(record, context);
          if (result) successCount += 1;
          else failedCount += 1;
        }

        if (!response.hasMore || response.transactions.length === 0) break;
        page += 1;
      }
    } catch (error) {
      failedCount += 1;
      await this.inventory.markUntouchedTransactionSync(Provider.photonpay, transactionSyncStartedAt, `failed:${providerErrorCategory(error)}`);
      const errorMessage = sanitizeErrorMessage(error instanceof Error ? error.message : 'PhotonPay card spend request failed.', credential);
      const providerError = safeProviderError(error);
      providerError.message = sanitizeErrorMessage(providerError.message, credential);
      return { ...this.result('failed', successCount, failedCount, window, errorMessage, context, cardInventory, providerError), errorCategory: providerErrorCategory(error) };
    }

    const status = failedCount === 0 ? 'completed' : 'failed';
    await this.inventory.markUntouchedTransactionSync(Provider.photonpay, transactionSyncStartedAt, 'completed:no_transactions');
    const message = `PhotonPay card spend sync finished: successCount=${successCount}, failedCount=${failedCount}.`;
    return this.result(status, successCount, failedCount, window, message, context, cardInventory);
  }

  private result(
    status: 'completed' | 'failed',
    successCount: number,
    failedCount: number,
    window: ReturnType<typeof getPhotonPayRequestAndSettlementWindows>,
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
        provider: Provider.photonpay,
        pulledThirdPartyData: cardInventory !== null || successCount > 0,
        successCount,
        failedCount,
        cardInventory,
        providerError,
        settlementMonth: context.settlementMonth.toISOString().slice(0, 10),
        requestWindow: {
          from: window.requestFrom.toISOString(),
          to: window.requestTo.toISOString(),
        },
        settlementWindow: {
          startInclusiveUtc: window.settlementStartInclusiveUtc.toISOString(),
          endExclusiveUtc: window.settlementEndExclusiveUtc.toISOString(),
          timezone: 'GMT+8',
        },
        settlementDelayDays: window.settlementDelayDays,
      },
    };
  }

  private async upsertCardSpendEvent(record: NormalizedPhotonPayTransaction, context: SyncAdapterContext): Promise<boolean> {
    if (!record.externalEventId) {
      await this.recordUnmatchedCardSpend(record, context, 'UNKNOWN', 'PhotonPay settled transaction is missing external event id.');
      return false;
    }
    if (!record.cardId) {
      await this.recordUnmatchedCardSpend(record, context, 'CARD_ID_MISSING', 'PhotonPay settled transaction is missing cardId.');
      return false;
    }
    if (!record.transactionAt) {
      await this.recordUnmatchedCardSpend(record, context, 'UNKNOWN', 'PhotonPay settled transaction is missing transactionAt.');
      return false;
    }
    if (record.currency !== 'USD') {
      await this.recordUnmatchedCardSpend(record, context, 'INVALID_CURRENCY', 'PhotonPay settled transaction currency is not USD.');
      return false;
    }

    const ownership = await this.inventory.resolveSpendOwner(Provider.photonpay, record.cardId, context.settlementMonth);
    if (!ownership.ok) {
      await this.recordUnmatchedCardSpend(record, context, ownership.reasonCode, ownership.reasonMessage);
      await this.inventory.markTransactionSync(Provider.photonpay, record.cardId, `unmatched:${ownership.reasonCode}`);
      return false;
    }

    const safeRawData = buildPhotonPayRawSafeData(record, ownership.subIdMapping);

    await this.db().cardSpendEvent.upsert({
      where: { provider_externalEventId: { provider: Provider.photonpay, externalEventId: record.externalEventId } },
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
        provider: Provider.photonpay,
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
      sourceType: SyncTaskSourceType.card_spend,
      taskType: SyncTaskType.photonpay_card,
      thirdPartyEventId: record.externalEventId,
      employeeId: ownership.employeeId,
      resolvedBy: context.requestedBy,
    });
    await this.inventory.markTransactionSync(Provider.photonpay, record.cardId, 'completed');
    return true;
  }

  private async recordUnmatchedCardSpend(
    record: NormalizedPhotonPayTransaction,
    context: SyncAdapterContext,
    reasonCode: string,
    reasonMessage: string,
  ) {
    await this.unmatchedEvents.recordUnmatchedEvent({
      settlementMonth: context.settlementMonth,
      sourceType: SyncTaskSourceType.card_spend,
      taskType: SyncTaskType.photonpay_card,
      provider: Provider.photonpay,
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
      rawSafeData: buildPhotonPayRawSafeData(record),
    });
  }

  private assertContext(context: SyncAdapterContext) {
    if (context.sourceType !== SyncTaskSourceType.card_spend || context.taskType !== SyncTaskType.photonpay_card) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'PhotonPay adapter only supports photonpay_card sync tasks.');
    }
    if (context.platform !== SyncTaskPlatform.photonpay || context.provider !== Provider.photonpay) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'card_spend provider/platform must be photonpay.');
    }
  }

  private db(): PhotonPayAdapterPrisma {
    return this.prisma as unknown as PhotonPayAdapterPrisma;
  }
}

export function getPhotonPayGmt8SettlementMonthWindow(settlementMonth: Date) {
  return getPhotonPayRequestAndSettlementWindows(settlementMonth, DEFAULT_SETTLEMENT_DELAY_DAYS);
}

export function getPhotonPayRequestAndSettlementWindows(settlementMonth: Date, settlementDelayDays: number) {
  const settlementStartInclusiveUtc = new Date(Date.UTC(settlementMonth.getUTCFullYear(), settlementMonth.getUTCMonth(), 1, -8, 0, 0, 0));
  const settlementEndExclusiveUtc = new Date(Date.UTC(settlementMonth.getUTCFullYear(), settlementMonth.getUTCMonth() + 1, 1, -8, 0, 0, 0));
  const requestTo = new Date(settlementEndExclusiveUtc.getTime() + settlementDelayDays * 24 * 60 * 60 * 1000);

  return {
    settlementStartInclusiveUtc,
    settlementEndExclusiveUtc,
    requestFrom: settlementStartInclusiveUtc,
    requestTo,
    settlementDelayDays,
  };
}

export function normalizePhotonPayTransaction(raw: PhotonPayTransactionRecord): NormalizedPhotonPayTransaction {
  const amount = firstValue(raw.transactionAmount, raw.transaction_amount, raw.amount);
  const transactionType = firstNonBlank(raw.transactionType, raw.transaction_type);
  const unsignedAmount = new Prisma.Decimal(typeof amount === 'number' || typeof amount === 'string' ? amount : 0).abs();
  const credit = ['REFUND', 'CORRECTIVE_REFUND'].includes(normalizeStatus(transactionType) ?? '');
  return {
    externalEventId: firstNonBlank(raw.transactionId, raw.transaction_id, raw.id),
    cardId: firstNonBlank(raw.cardId, raw.card_id),
    cardLast4: lastFour(firstNonBlank(raw.maskCardNo, raw.mask_card_no, raw.cardLast4)),
    cardEmail: null,
    transactionAt: parseDate(firstValue(raw.txnDate, raw.txn_date)),
    amount: credit ? unsignedAmount.negated() : unsignedAmount,
    currency: firstNonBlank(raw.transactionCurrency, raw.transaction_currency, raw.currency)?.toUpperCase() ?? null,
    settledAt: parseDate(firstValue(raw.settlementDate, raw.settlement_date)),
    sourceStatus: [firstNonBlank(raw.settleStatus, raw.settle_status), firstNonBlank(raw.status), transactionType].filter(Boolean).join('|') || null,
    settleStatus: firstNonBlank(raw.settleStatus, raw.settle_status),
    transactionStatus: firstNonBlank(raw.status),
    transactionType,
    sourceUpdatedAt: parseDate(firstValue(raw.createdAt, raw.created_at, raw.settlementDate, raw.settlement_date)),
  };
}

function isSettled(record: NormalizedPhotonPayTransaction): boolean {
  const settleStatus = normalizeStatus(record.settleStatus);
  const status = normalizeStatus(record.transactionStatus);
  const type = normalizeStatus(record.transactionType);
  return settleStatus === 'SETTLED'
    && status === 'SUCCEED'
    && ['AUTH', 'CORRECTIVE_AUTH', 'REFUND', 'CORRECTIVE_REFUND', 'REFUND_REVERSAL', 'CORRECTIVE_REFUND_VOID'].includes(type ?? '');
}

function normalizeStatus(value: string | null): string | null {
  if (!value) return null;
  return value.trim().replace(/[\s-]+/g, '_').toUpperCase();
}

function isInsideSettlementWindow(date: Date | null, window: ReturnType<typeof getPhotonPayRequestAndSettlementWindows>): boolean {
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

function lastFour(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
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

function buildPhotonPayRawSafeData(
  record: NormalizedPhotonPayTransaction,
  subIdMapping?: { affiliateAccountId: string; subField: string; subValue: string },
): Prisma.InputJsonObject {
  return {
    transactionId: record.externalEventId,
    cardId: record.cardId,
    cardLast4: record.cardLast4,
    cardEmail: record.cardEmail,
    settleStatus: record.settleStatus,
    status: record.transactionStatus,
    transactionType: record.transactionType,
    amount: record.amount.toString(),
    currency: record.currency,
    transactionAt: record.transactionAt?.toISOString(),
    settledAt: record.settledAt?.toISOString(),
    affiliateAccountId: subIdMapping?.affiliateAccountId,
    subField: subIdMapping?.subField,
    subValue: subIdMapping?.subValue,
  };
}

function sanitizeErrorMessage(message: string, credential: PhotonPayCredentialPayload): string {
  return [credential.appId, credential.appSecret]
    .reduce((sanitized, secret) => sanitized.split(secret).join('[REDACTED]'), message);
}
