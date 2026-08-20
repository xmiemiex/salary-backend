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
const MAX_PROVIDER_QUERY_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;

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
    findUnique(args: unknown): Promise<{
      cardId: string;
      employeeId: string | null;
      transactionAt: Date;
      amount: Prisma.Decimal | null;
      currency: string | null;
      spendUsd: Prisma.Decimal;
      settledAt: Date | null;
      sourceStatus: string | null;
      sourceUpdatedAt: Date | null;
      status: string;
    } | null>;
    upsert(args: unknown): Promise<unknown>;
  };
};

type ImportOutcome = 'created' | 'updated' | 'skipped' | 'failed';

type PhotonPayExecutionStats = {
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  providerTransactionCount: number;
  settledTransactionCount: number;
  nonSettledTransactionCount: number;
  duplicateBoundaryCount: number;
  outOfWindowCount: number;
  nonUsdSettledCount: number;
  settledAmountByCurrency: Record<string, string>;
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
    const window = getPhotonPayExecutionWindow(context, credential);

    let successCount = 0;
    let failedCount = 0;
    const stats: PhotonPayExecutionStats = {
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      providerTransactionCount: 0,
      settledTransactionCount: 0,
      nonSettledTransactionCount: 0,
      duplicateBoundaryCount: 0,
      outOfWindowCount: 0,
      nonUsdSettledCount: 0,
      settledAmountByCurrency: {},
    };
    const transactionSyncStartedAt = new Date();
    let cardInventory: Awaited<ReturnType<ProviderCardInventoryService['syncProviderWithPayload']>> | null = null;

    try {
      cardInventory = await this.inventory.syncProviderWithPayload(Provider.photonpay, context.credential.payload, context.settlementMonth);
      const seenTransactions = new Set<string>();
      const settledAmounts = new Map<string, Prisma.Decimal>();
      for (const queryWindow of splitPhotonPayQueryWindow(window.requestFrom, window.requestTo)) {
        let page = 1;
        while (true) {
          const response = await this.client.listCardTransactions({
            credential,
            from: queryWindow.from,
            to: queryWindow.to,
            page,
            pageSize: PAGE_SIZE,
          });
          stats.providerTransactionCount += response.transactions.length;

          for (const raw of response.transactions) {
            const record = normalizePhotonPayTransaction(raw);
            const transactionKey = record.externalEventId ?? [
              record.cardId,
              record.transactionAt?.toISOString(),
              record.amount.toString(),
              record.currency,
              record.transactionType,
            ].join('|');
            if (seenTransactions.has(transactionKey)) {
              stats.duplicateBoundaryCount += 1;
              continue;
            }
            seenTransactions.add(transactionKey);
            if (!isSettled(record)) {
              stats.nonSettledTransactionCount += 1;
              continue;
            }
            if (!record.transactionAt) {
              await this.recordUnmatchedCardSpend(record, context, 'UNKNOWN', 'PhotonPay settled transaction is missing transactionAt.');
              failedCount += 1;
              continue;
            }
            if (!isInsideRequestAndSettlementWindow(record.transactionAt, window)) {
              stats.outOfWindowCount += 1;
              continue;
            }
            stats.settledTransactionCount += 1;
            const currency = record.currency ?? 'UNKNOWN';
            settledAmounts.set(currency, (settledAmounts.get(currency) ?? new Prisma.Decimal(0)).add(record.amount));
            if (record.currency !== 'USD') stats.nonUsdSettledCount += 1;

            const outcome = await this.upsertCardSpendEvent(record, context);
            if (outcome === 'failed') failedCount += 1;
            else {
              successCount += 1;
              if (outcome === 'created') stats.createdCount += 1;
              else if (outcome === 'updated') stats.updatedCount += 1;
              else stats.skippedCount += 1;
            }
          }

          if (!response.hasMore || response.transactions.length === 0) break;
          page += 1;
        }
      }
      stats.settledAmountByCurrency = Object.fromEntries([...settledAmounts].map(([currency, amount]) => [currency, amount.toString()]));
    } catch (error) {
      failedCount += 1;
      await this.inventory.markUntouchedTransactionSync(Provider.photonpay, transactionSyncStartedAt, `failed:${providerErrorCategory(error)}`);
      const errorMessage = sanitizeErrorMessage(error instanceof Error ? error.message : 'PhotonPay card spend request failed.', credential);
      const providerError = safeProviderError(error);
      providerError.message = sanitizeErrorMessage(providerError.message, credential);
      return { ...this.result('failed', successCount, failedCount, window, errorMessage, context, cardInventory, stats, providerError), errorCategory: providerErrorCategory(error) };
    }

    const status = failedCount === 0 ? 'completed' : 'failed';
    await this.inventory.markUntouchedTransactionSync(Provider.photonpay, transactionSyncStartedAt, 'completed:no_transactions');
    const message = `PhotonPay card spend sync finished: successCount=${successCount}, failedCount=${failedCount}.`;
    return this.result(status, successCount, failedCount, window, message, context, cardInventory, stats);
  }

  private result(
    status: 'completed' | 'failed',
    successCount: number,
    failedCount: number,
    window: ReturnType<typeof getPhotonPayExecutionWindow>,
    message: string,
    context: SyncAdapterContext,
    cardInventory: Awaited<ReturnType<ProviderCardInventoryService['syncProviderWithPayload']>> | null,
    stats: PhotonPayExecutionStats,
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
        ...stats,
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
        verificationMode: window.verificationMode,
      },
    };
  }

  private async upsertCardSpendEvent(record: NormalizedPhotonPayTransaction, context: SyncAdapterContext): Promise<ImportOutcome> {
    if (!record.externalEventId) {
      await this.recordUnmatchedCardSpend(record, context, 'UNKNOWN', 'PhotonPay settled transaction is missing external event id.');
      return 'failed';
    }
    if (!record.cardId) {
      await this.recordUnmatchedCardSpend(record, context, 'CARD_ID_MISSING', 'PhotonPay settled transaction is missing cardId.');
      return 'failed';
    }
    if (!record.transactionAt) {
      await this.recordUnmatchedCardSpend(record, context, 'UNKNOWN', 'PhotonPay settled transaction is missing transactionAt.');
      return 'failed';
    }
    if (record.currency !== 'USD') {
      await this.recordUnmatchedCardSpend(record, context, 'INVALID_CURRENCY', 'PhotonPay settled transaction currency is not USD.');
      return 'failed';
    }

    const ownership = await this.inventory.resolveSpendOwner(Provider.photonpay, record.cardId, context.settlementMonth);
    if (!ownership.ok) {
      await this.recordUnmatchedCardSpend(record, context, ownership.reasonCode, ownership.reasonMessage);
      await this.inventory.markTransactionSync(Provider.photonpay, record.cardId, `unmatched:${ownership.reasonCode}`);
      return 'failed';
    }

    const safeRawData = buildPhotonPayRawSafeData(record);
    const existing = await this.db().cardSpendEvent.findUnique({
      where: { provider_externalEventId: { provider: Provider.photonpay, externalEventId: record.externalEventId } },
      select: {
        cardId: true,
        employeeId: true,
        transactionAt: true,
        amount: true,
        currency: true,
        spendUsd: true,
        settledAt: true,
        sourceStatus: true,
        sourceUpdatedAt: true,
        status: true,
      },
    });
    if (existing && sameImportedTransaction(existing, record, ownership.employeeId)) return 'skipped';

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
      settlementMonth: context.settlementMonth,
      sourceType: SyncTaskSourceType.card_spend,
      taskType: SyncTaskType.photonpay_card,
      provider: Provider.photonpay,
      thirdPartyEventId: record.externalEventId,
      cardId: record.cardId,
      employeeId: ownership.employeeId,
      resolvedBy: context.requestedBy,
    });
    await this.inventory.markTransactionSync(Provider.photonpay, record.cardId, 'completed');
    return existing ? 'updated' : 'created';
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

function getPhotonPayExecutionWindow(context: SyncAdapterContext, credential: PhotonPayCredentialPayload) {
  const standard = getPhotonPayRequestAndSettlementWindows(
    context.settlementMonth,
    credential.settlementDelayDays ?? DEFAULT_SETTLEMENT_DELAY_DAYS,
  );
  const requestPayload = asRecord(context.requestPayload);
  if (!requestPayload?.verificationWindow) return { ...standard, verificationMode: false };
  const verificationWindow = parsePhotonPayVerificationWindow(
    requestPayload.verificationWindow,
    context.settlementMonth,
    new Date(),
    false,
  );
  return {
    ...standard,
    requestFrom: verificationWindow.from,
    requestTo: verificationWindow.to,
    settlementDelayDays: 0,
    verificationMode: true,
  };
}

export function parsePhotonPayVerificationWindow(
  input: unknown,
  settlementMonth: Date,
  now = new Date(),
  requirePreviousCompleteDays = true,
) {
  const record = asRecord(input);
  if (!record || typeof record.from !== 'string' || typeof record.to !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'verificationWindow.from and verificationWindow.to are required ISO timestamps.');
  }
  const from = new Date(record.from);
  const to = new Date(record.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'verificationWindow must be a valid increasing interval.');
  }
  if (!isShanghaiMidnight(from) || !isShanghaiMidnight(to)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'verificationWindow boundaries must be Asia/Shanghai natural-day midnights.');
  }
  const durationDays = (to.getTime() - from.getTime()) / DAY_MS;
  if (durationDays !== 1 && durationDays !== 7) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'verificationWindow must contain exactly 1 or 7 complete natural days.');
  }
  const settlementWindow = getPhotonPayRequestAndSettlementWindows(settlementMonth, 0);
  if (from < settlementWindow.settlementStartInclusiveUtc || to > settlementWindow.settlementEndExclusiveUtc) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'verificationWindow must stay inside the selected GMT+8 settlement month.');
  }
  if (requirePreviousCompleteDays) {
    const currentDayStart = shanghaiDayStartUtc(now);
    if (to.getTime() !== currentDayStart.getTime() || from.getTime() !== to.getTime() - durationDays * DAY_MS) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'verificationWindow must end at today 00:00 Asia/Shanghai and cover the previous 1 or 7 complete days.');
    }
  }
  return { from, to, durationDays: durationDays as 1 | 7 };
}

export function splitPhotonPayQueryWindow(from: Date, to: Date) {
  const windows: Array<{ from: Date; to: Date }> = [];
  const maximumWindowMs = MAX_PROVIDER_QUERY_WINDOW_DAYS * DAY_MS;
  let cursor = new Date(from);
  while (cursor < to) {
    const end = new Date(Math.min(cursor.getTime() + maximumWindowMs, to.getTime()));
    windows.push({ from: new Date(cursor), to: end });
    cursor = end;
  }
  return windows;
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

function isInsideRequestAndSettlementWindow(date: Date, window: ReturnType<typeof getPhotonPayExecutionWindow>): boolean {
  return date >= window.requestFrom
    && date < window.requestTo
    && date >= window.settlementStartInclusiveUtc
    && date < window.settlementEndExclusiveUtc;
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
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameImportedTransaction(
  existing: Awaited<ReturnType<PhotonPayAdapterPrisma['cardSpendEvent']['findUnique']>> & {},
  record: NormalizedPhotonPayTransaction,
  employeeId: string,
) {
  return existing.cardId === record.cardId
    && existing.employeeId === employeeId
    && existing.transactionAt.getTime() === record.transactionAt?.getTime()
    && existing.amount?.equals(record.amount) === true
    && existing.currency === record.currency
    && existing.spendUsd.equals(record.amount)
    && sameDate(existing.settledAt, record.settledAt)
    && existing.sourceStatus === record.sourceStatus
    && sameDate(existing.sourceUpdatedAt, record.sourceUpdatedAt)
    && existing.status === 'confirmed';
}

function sameDate(left: Date | null, right: Date | null) {
  return left?.getTime() === right?.getTime();
}

function isShanghaiMidnight(date: Date) {
  return (date.getTime() + 8 * 60 * 60 * 1_000) % DAY_MS === 0;
}

function shanghaiDayStartUtc(date: Date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), -8, 0, 0, 0));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function buildPhotonPayRawSafeData(record: NormalizedPhotonPayTransaction): Prisma.InputJsonObject {
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
  };
}

function sanitizeErrorMessage(message: string, credential: PhotonPayCredentialPayload): string {
  return [credential.appId, credential.appSecret]
    .reduce((sanitized, secret) => sanitized.split(secret).join('[REDACTED]'), message);
}
