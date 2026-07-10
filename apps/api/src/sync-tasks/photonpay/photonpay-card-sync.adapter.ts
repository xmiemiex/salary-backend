import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma, Provider, SyncTaskPlatform, SyncTaskSourceType, SyncTaskType } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../../common/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncUnmatchedEventsService } from '../../sync-unmatched-events/sync-unmatched-events.service';
import { SyncAdapter, SyncAdapterContext, SyncAdapterResult } from '../sync-adapter';
import { providerErrorCategory } from '../provider-request-error';
import { PhotonPayClient, PhotonPayCredentialPayload, PhotonPayTransactionRecord } from './photonpay-client';

const PAGE_SIZE = 200;
const DEFAULT_SETTLEMENT_DELAY_DAYS = 10;
const MAX_SETTLEMENT_DELAY_DAYS = 31;
const PHOTONPAY_SETTLED_STATUS_ZH = '\u5df2\u7ed3\u7b97';

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
  sourceUpdatedAt: Date | null;
  rawData: PhotonPayTransactionRecord;
};

type PhotonPayAdapterPrisma = {
  cardBinding: {
    findFirst(args: unknown): Promise<{ employeeId: string } | null>;
  };
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
  ) {}

  async execute(context: SyncAdapterContext): Promise<SyncAdapterResult> {
    this.assertContext(context);
    const credential = parseCredentialPayload(context.credential.payload);
    const window = getPhotonPayRequestAndSettlementWindows(context.settlementMonth, credential.settlementDelayDays ?? DEFAULT_SETTLEMENT_DELAY_DAYS);

    let successCount = 0;
    let failedCount = 0;
    let page = 1;

    try {
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
          if (!isInsideSettlementWindow(record.transactionAt, window)) {
            await this.recordUnmatchedCardSpend(record, context, 'OUTSIDE_SETTLEMENT_WINDOW', 'PhotonPay settled transactionAt is outside the GMT+8 settlement window.');
            failedCount += 1;
            continue;
          }

          const result = await this.upsertCardSpendEvent(record, context);
          if (result) successCount += 1;
          else failedCount += 1;
        }

        if (!response.hasMore || response.transactions.length === 0) break;
        page += 1;
      }
    } catch (error) {
      failedCount += 1;
      const errorMessage = sanitizeErrorMessage(error instanceof Error ? error.message : 'PhotonPay card spend request failed.', credential);
      return { ...this.result('failed', successCount, failedCount, window, errorMessage, context), errorCategory: providerErrorCategory(error) };
    }

    const status = successCount > 0 && failedCount === 0 ? 'completed' : 'failed';
    const message = `PhotonPay card spend sync finished: successCount=${successCount}, failedCount=${failedCount}.`;
    return this.result(status, successCount, failedCount, window, message, context);
  }

  private result(
    status: 'completed' | 'failed',
    successCount: number,
    failedCount: number,
    window: ReturnType<typeof getPhotonPayRequestAndSettlementWindows>,
    message: string,
    context: SyncAdapterContext,
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
        pulledThirdPartyData: true,
        successCount,
        failedCount,
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

    const mapping = await this.db().cardBinding.findFirst({
      where: {
        provider: Provider.photonpay,
        cardId: record.cardId,
        effectiveMonth: context.settlementMonth,
        status: CommonStatus.active,
      },
      select: { employeeId: true },
    });
    if (!mapping) {
      await this.recordUnmatchedCardSpend(record, context, 'CARD_NOT_MAPPED', 'PhotonPay cardId is not mapped to an employee.');
      return false;
    }

    await this.db().cardSpendEvent.upsert({
      where: { provider_externalEventId: { provider: Provider.photonpay, externalEventId: record.externalEventId } },
      update: {
        settlementMonth: context.settlementMonth,
        cardId: record.cardId,
        employeeId: mapping.employeeId,
        transactionAt: record.transactionAt,
        amount: record.amount,
        currency: record.currency,
        spendUsd: record.amount,
        settledAt: record.settledAt,
        sourceStatus: record.sourceStatus,
        sourceUpdatedAt: record.sourceUpdatedAt,
        rawData: record.rawData as Prisma.InputJsonObject,
        status: CommonStatus.confirmed,
        importedBy: context.requestedBy,
      },
      create: {
        provider: Provider.photonpay,
        externalEventId: record.externalEventId,
        settlementMonth: context.settlementMonth,
        cardId: record.cardId,
        employeeId: mapping.employeeId,
        transactionAt: record.transactionAt,
        amount: record.amount,
        currency: record.currency,
        spendUsd: record.amount,
        settledAt: record.settledAt,
        sourceStatus: record.sourceStatus,
        sourceUpdatedAt: record.sourceUpdatedAt,
        rawData: record.rawData as Prisma.InputJsonObject,
        status: CommonStatus.confirmed,
        importedBy: context.requestedBy,
      },
    });
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
  const amount = firstValue(raw.amount, raw.transactionAmount, raw.transaction_amount, raw.billingAmount, raw.billing_amount, raw.settlementAmount, raw.settlement_amount);
  return {
    externalEventId: firstNonBlank(raw.id, raw.transactionId, raw.transaction_id, raw.tradeId, raw.trade_id, raw.orderId, raw.order_id),
    cardId: firstNonBlank(
      raw.cardId,
      raw.card_id,
      raw.cardNo,
      raw.card_no,
      raw.cardNumberMask,
      raw.card_number_mask,
      raw.cardIdentifier,
      raw.card_identifier,
      recordField(raw.card, 'id'),
      recordField(raw.card, 'cardId'),
      recordField(raw.card, 'card_id'),
      recordField(raw.card, 'cardNumberMask'),
    ),
    cardLast4: firstNonBlank(raw.cardLast4, raw.card_last4, raw.last4, recordField(raw.card, 'last4'), recordField(raw.card, 'cardLast4'), recordField(raw.card, 'card_last4')),
    cardEmail: firstNonBlank(raw.cardEmail, raw.card_email, raw.email, recordField(raw.card, 'email'), recordField(raw.card, 'cardEmail'), recordField(raw.card, 'card_email')),
    transactionAt: parseDate(firstValue(raw.transactionAt, raw.transaction_at, raw.transactionTime, raw.transaction_time, raw.tradeTime, raw.trade_time)),
    amount: new Prisma.Decimal(typeof amount === 'number' || typeof amount === 'string' ? amount : 0),
    currency: firstNonBlank(raw.currency, raw.transactionCurrency, raw.transaction_currency, raw.billingCurrency, raw.billing_currency, raw.settlementCurrency, raw.settlement_currency)?.toUpperCase() ?? null,
    settledAt: parseDate(firstValue(raw.settledAt, raw.settled_at, raw.settlementAt, raw.settlement_at, raw.settleTime, raw.settle_time)),
    sourceStatus: firstNonBlank(raw.settleStatus, raw.settle_status, raw.settlementStatus, raw.settlement_status),
    sourceUpdatedAt: parseDate(firstValue(raw.updatedAt, raw.updated_at, raw.updateTime, raw.update_time, raw.createdAt, raw.created_at)),
    rawData: raw,
  };
}

function parseCredentialPayload(payload: unknown): PhotonPayCredentialPayload {
  if (!payload || typeof payload !== 'object') {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'PhotonPay credential payload is required.');
  }
  const record = payload as Record<string, unknown>;
  const apiKey = asNonBlankString(record.apiKey);
  const token = asNonBlankString(record.token);
  const secret = asNonBlankString(record.secret);
  const merchantId = asNonBlankString(record.merchantId);
  if (!apiKey && !token) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'PhotonPay credential apiKey or token is required.');

  return {
    baseUrl: asNonBlankString(record.baseUrl) ?? undefined,
    transactionsPath: asNonBlankString(record.transactionsPath) ?? undefined,
    apiKey: apiKey ?? undefined,
    token: token ?? undefined,
    secret: secret ?? undefined,
    merchantId: merchantId ?? undefined,
    settlementDelayDays: parseSettlementDelayDays(record.settlementDelayDays),
  };
}

function isSettled(record: NormalizedPhotonPayTransaction): boolean {
  const normalized = normalizeStatus(record.sourceStatus);
  return normalized === PHOTONPAY_SETTLED_STATUS_ZH || normalized === 'SETTLED' || normalized === 'SETTLED_SUCCESS';
}

function normalizeStatus(value: string | null): string | null {
  if (!value) return null;
  return value.trim().replace(/[\s-]+/g, '_').toUpperCase();
}

function isInsideSettlementWindow(date: Date | null, window: ReturnType<typeof getPhotonPayRequestAndSettlementWindows>): boolean {
  return !!date && date >= window.settlementStartInclusiveUtc && date < window.settlementEndExclusiveUtc;
}

function recordField(value: unknown, field: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[field] : undefined;
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

function buildPhotonPayRawSafeData(record: NormalizedPhotonPayTransaction): Prisma.InputJsonObject {
  return {
    transactionId: record.externalEventId,
    cardId: record.cardId,
    cardLast4: record.cardLast4,
    cardEmail: record.cardEmail,
    status: record.sourceStatus,
    sourceStatus: record.sourceStatus,
    amount: record.amount.toString(),
    currency: record.currency,
    transactionAt: record.transactionAt?.toISOString(),
    settledAt: record.settledAt?.toISOString(),
  };
}

function sanitizeErrorMessage(message: string, credential: PhotonPayCredentialPayload): string {
  return [credential.apiKey, credential.token, credential.secret, credential.merchantId]
    .filter((value): value is string => !!value)
    .reduce((sanitized, secret) => sanitized.split(secret).join('[REDACTED]'), message);
}
