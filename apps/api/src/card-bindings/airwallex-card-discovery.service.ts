import { Injectable } from '@nestjs/common';
import { CommonStatus, Provider } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { CredentialReaderService } from '../api-credentials/credential-reader.service';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import {
  AirwallexClient,
  AirwallexCredentialPayload,
  AirwallexTransactionRecord,
} from '../sync-tasks/airwallex/airwallex-client';
import { ProviderRequestError } from '../sync-tasks/provider-request-error';

const PAGE_SIZE = 200;
const FIRST_CARD_CREATED_AT = new Date('2000-01-01T00:00:00.000Z');
const MAX_PAGES = 1_000;

type EmployeeReference = {
  id: string;
  employeeCode: string;
  name: string;
  email: string | null;
};

export type AirwallexDiscoveredCard = {
  cardId: string;
  last4: string | null;
  nickname: string | null;
  cardStatus: string | null;
  cardholderId: string | null;
  cardholderName: string | null;
  cardholderEmail: string | null;
  suggestedEmployeeId: string | null;
  suggestedEmployeeCode: string | null;
  suggestedEmployeeName: string | null;
  mappingHint: 'unique_email_match' | 'multiple_cardholders' | 'cardholder_not_found' | 'employee_not_found' | 'employee_email_ambiguous';
};

@Injectable()
export class AirwallexCardDiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialReaderService,
    private readonly client: AirwallexClient,
  ) {}

  async discover() {
    const internalCredential = await this.credentials.getCardProviderCredentialPayload(Provider.airwallex);
    const credential = parseCredential(internalCredential.payload);
    let cards: AirwallexTransactionRecord[];
    try {
      cards = await this.loadAllCards(credential);
    } catch (error) {
      throw discoveryError(error, 'cards');
    }
    const warnings: string[] = [];
    let cardholders: AirwallexTransactionRecord[] = [];

    try {
      cardholders = await this.loadAllCardholders(credential);
    } catch (error) {
      warnings.push(discoveryWarning(error, 'cardholders'));
    }

    const employees = await this.prisma.employee.findMany({
      where: { status: CommonStatus.active },
      select: { id: true, employeeCode: true, name: true, email: true },
      orderBy: { employeeCode: 'asc' },
    });
    const holderById = new Map(cardholders.map((holder) => [firstString(holder.cardholder_id, holder.id), holder]).filter((entry): entry is [string, AirwallexTransactionRecord] => Boolean(entry[0])));

    return {
      provider: Provider.airwallex,
      cardCount: cards.length,
      cards: cards
        .map((card) => normalizeCard(card, holderById, employees))
        .filter((card): card is AirwallexDiscoveredCard => card !== null)
        .sort((left, right) => cardLabel(left).localeCompare(cardLabel(right), 'zh-CN')),
      warnings,
    };
  }

  private async loadAllCards(credential: AirwallexCredentialPayload) {
    const records: AirwallexTransactionRecord[] = [];
    const to = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.client.listCards({
        credential,
        page,
        pageSize: PAGE_SIZE,
        from: FIRST_CARD_CREATED_AT,
        to,
      });
      records.push(...response.cards);
      if (!response.hasMore || response.cards.length === 0) return records;
    }
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Airwallex card pagination exceeded the safety limit.');
  }

  private async loadAllCardholders(credential: AirwallexCredentialPayload) {
    const records: AirwallexTransactionRecord[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.client.listCardholders({ credential, page, pageSize: PAGE_SIZE });
      records.push(...response.cardholders);
      if (!response.hasMore || response.cardholders.length === 0) return records;
    }
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Airwallex cardholder pagination exceeded the safety limit.');
  }
}

function parseCredential(payload: unknown): AirwallexCredentialPayload {
  if (!isRecord(payload)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Airwallex credential payload is invalid.');
  const clientId = firstString(payload.clientId, payload.client_id);
  const apiKey = firstString(payload.apiKey, payload.api_key, payload.secret);
  if (!clientId) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Airwallex credential clientId is required.');
  if (!apiKey) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Airwallex credential apiKey is required.');
  return {
    clientId,
    apiKey,
    baseUrl: firstString(payload.baseUrl, payload.base_url) ?? undefined,
    transactionsPath: firstString(payload.transactionsPath, payload.transactions_path) ?? undefined,
    cardsPath: firstString(payload.cardsPath, payload.cards_path) ?? undefined,
    cardholdersPath: firstString(payload.cardholdersPath, payload.cardholders_path) ?? undefined,
    apiVersion: firstString(payload.apiVersion, payload.api_version) ?? undefined,
  };
}

function normalizeCard(
  card: AirwallexTransactionRecord,
  holderById: Map<string, AirwallexTransactionRecord>,
  employees: EmployeeReference[],
): AirwallexDiscoveredCard | null {
  const cardId = firstString(card.card_id, card.id);
  if (!cardId) return null;
  const additionalHolderIds = stringArray(card.additional_cardholder_ids);
  const cardholderId = firstString(card.cardholder_id, nestedValue(card.cardholder, 'cardholder_id'), nestedValue(card.cardholder, 'id'));
  const holder = cardholderId ? holderById.get(cardholderId) : undefined;
  const cardholderEmail = firstString(
    holder?.email,
    nestedValue(card.cardholder, 'email'),
    nestedValue(card.primary_contact_details, 'email'),
    nestedValue(card.user, 'email'),
  );
  const cardholderName = firstString(
    holderName(holder),
    nestedValue(card.cardholder, 'name'),
    nestedValue(card.user, 'name'),
  );
  const matchingEmployees = cardholderEmail
    ? employees.filter((employee) => employee.email?.trim().toLowerCase() === cardholderEmail.toLowerCase())
    : [];
  const hasMultipleCardholders = additionalHolderIds.some((id) => id !== cardholderId);
  const suggestion = !hasMultipleCardholders && matchingEmployees.length === 1 ? matchingEmployees[0] : null;

  return {
    cardId,
    last4: lastFour(firstString(card.card_number, card.masked_card_number, card.last4)),
    nickname: firstString(card.nick_name, card.nickname, card.card_nickname),
    cardStatus: firstString(card.card_status, card.status),
    cardholderId,
    cardholderName,
    cardholderEmail,
    suggestedEmployeeId: suggestion?.id ?? null,
    suggestedEmployeeCode: suggestion?.employeeCode ?? null,
    suggestedEmployeeName: suggestion?.name ?? null,
    mappingHint: hasMultipleCardholders
      ? 'multiple_cardholders'
      : !cardholderEmail
        ? 'cardholder_not_found'
        : matchingEmployees.length === 0
          ? 'employee_not_found'
          : matchingEmployees.length > 1
            ? 'employee_email_ambiguous'
            : 'unique_email_match',
  };
}

function holderName(holder: AirwallexTransactionRecord | undefined): string | null {
  if (!holder) return null;
  const name = isRecord(holder.individual) && isRecord(holder.individual.name) ? holder.individual.name : null;
  return firstString(
    holder.name,
    [name?.first_name, name?.middle_name, name?.last_name].filter((part) => typeof part === 'string' && part.trim()).join(' '),
  );
}

function cardLabel(card: AirwallexDiscoveredCard): string {
  return `${card.cardholderName ?? ''} ${card.cardholderEmail ?? ''} ${card.nickname ?? ''} ${card.last4 ?? ''}`;
}

function lastFour(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function nestedValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function discoveryError(error: unknown, resource: 'cards'): AppError {
  if (!(error instanceof ProviderRequestError)) {
    return new AppError(ERROR_CODES.VALIDATION_ERROR, 'Airwallex 卡片发现失败；未返回或保存任何卡片数据。');
  }
  const message =
    error.category === 'CREDENTIAL_INVALID'
      ? 'Airwallex 拒绝了当前凭证或该凭证缺少 Cards 只读权限。'
      : error.category === 'RATE_LIMITED'
        ? 'Airwallex Cards 接口触发限流，请稍后重试。'
        : error.category === 'PROVIDER_5XX'
          ? 'Airwallex Cards 服务暂时不可用，请稍后重试。'
          : error.category === 'TIMEOUT' || error.category === 'NETWORK_ERROR'
            ? '无法连接 Airwallex Cards 服务，请稍后重试。'
            : 'Airwallex 拒绝了卡片列表请求；请检查 Cards 只读权限和 API 版本兼容性。';
  return new AppError(ERROR_CODES.VALIDATION_ERROR, message, { resource, category: error.category });
}

function discoveryWarning(error: unknown, resource: 'cardholders'): string {
  if (!(error instanceof ProviderRequestError)) {
    return 'Airwallex 持卡人接口不可用；卡片已返回，但无法显示持卡人姓名和邮箱。';
  }
  if (error.category === 'CREDENTIAL_INVALID') {
    return 'Airwallex 凭证缺少 Cardholders 只读权限；卡片已返回，但无法显示持卡人姓名和邮箱。';
  }
  if (error.category === 'RATE_LIMITED') {
    return 'Airwallex Cardholders 接口触发限流；卡片已返回，但持卡人信息暂不可用。';
  }
  return `Airwallex Cardholders 接口不可用（${error.category}）；卡片已返回，但持卡人信息暂不可用。`;
}
