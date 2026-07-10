import { Injectable } from '@nestjs/common';
import { Prisma, SettlementStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { Actor, ListQuery } from '../base-data/base-data.types';
import {
  changedFields,
  notFound,
  optionalNonBlank,
  parseDecimalString,
  parseMonthStart,
  requireNonBlank,
} from '../base-data/base-data.utils';
import { assertDecimalEquals, assertOptionalStatus, auditInput } from '../base-data/manual-entry.utils';
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';

const CARD_SPEND_STATUSES = [SettlementStatus.draft, SettlementStatus.confirmed] as const;
const ONE = new Prisma.Decimal('1');

export type CreateManualCardSpendEntryInput = {
  settlementMonth: string | Date;
  employeeId: string;
  providerName: string;
  cardIdentifier?: string;
  settledSpendUsd: string;
  feeRate: string;
  actualSpendUsd?: string;
  reason?: string;
  status?: SettlementStatus;
};

export type UpdateManualCardSpendEntryInput = Partial<CreateManualCardSpendEntryInput>;

@Injectable()
export class ManualCardSpendEntriesService {
  readonly requiredPermission = 'manual_card_spend.manage';

  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateManualCardSpendEntryInput, actor: Actor) {
    const data = this.validateCreate(input);
    await this.assertWritable(data.settlementMonth, 'manual_card_spend_entry.create', undefined, input, actor);
    const entry = await this.prisma.manualCardSpendEntry.create({
      data: { ...data, createdBy: actor.userId },
    });
    await this.audit.success(
      auditInput({
        actor,
        action: 'manual_card_spend_entry.create',
        objectType: 'manual_card_spend_entries',
        objectId: entry.id,
        settlementMonth: entry.settlementMonth,
        afterData: entry,
        changedFields: Object.keys(data),
        requestPayload: input,
      }),
    );
    return entry;
  }

  async list(query: ListQuery = {}) {
    return this.prisma.manualCardSpendEntry.findMany({
      where: {
        status: query.status as SettlementStatus | undefined,
        employeeId: query.employeeId,
        settlementMonth: query.settlementMonth ? parseMonthStart(query.settlementMonth, 'settlementMonth') : undefined,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const entry = await this.prisma.manualCardSpendEntry.findUnique({ where: { id } });
    if (!entry) throw notFound('Manual card spend entry');
    return entry;
  }

  async update(id: string, input: UpdateManualCardSpendEntryInput, actor: Actor) {
    const before = await this.get(id);
    const data = this.validateUpdate(input, before);
    await this.assertWritable(before.settlementMonth, 'manual_card_spend_entry.update', id, input, actor);
    const nextSettlementMonth = (data.settlementMonth as Date | undefined) ?? before.settlementMonth;
    if (nextSettlementMonth.getTime() !== before.settlementMonth.getTime()) {
      await this.assertWritable(nextSettlementMonth, 'manual_card_spend_entry.update', id, input, actor);
    }

    const after = await this.prisma.manualCardSpendEntry.update({ where: { id }, data });
    await this.audit.success(
      auditInput({
        actor,
        action: 'manual_card_spend_entry.update',
        objectType: 'manual_card_spend_entries',
        objectId: id,
        settlementMonth: after.settlementMonth,
        beforeData: before,
        afterData: after,
        changedFields: changedFields(before as never, after as never, Object.keys(data)),
        requestPayload: input,
      }),
    );
    return after;
  }

  async confirm(id: string, actor: Actor) {
    const before = await this.get(id);
    await this.assertWritable(before.settlementMonth, 'manual_card_spend_entry.confirm', id, { id }, actor);
    const after = await this.prisma.manualCardSpendEntry.update({
      where: { id },
      data: { status: SettlementStatus.confirmed },
    });
    await this.audit.success(
      auditInput({
        actor,
        action: 'manual_card_spend_entry.confirm',
        objectType: 'manual_card_spend_entries',
        objectId: id,
        settlementMonth: before.settlementMonth,
        beforeData: before,
        afterData: after,
        changedFields: ['status'],
        requestPayload: { id },
      }),
    );
    return after;
  }

  async disable(id: string, actor: Actor) {
    const before = await this.get(id);
    await this.assertWritable(before.settlementMonth, 'manual_card_spend_entry.disable', id, { id }, actor);
    const after = await this.prisma.manualCardSpendEntry.update({
      where: { id },
      data: { status: SettlementStatus.draft },
    });
    await this.audit.success(
      auditInput({
        actor,
        action: 'manual_card_spend_entry.disable',
        objectType: 'manual_card_spend_entries',
        objectId: id,
        settlementMonth: before.settlementMonth,
        beforeData: before,
        afterData: after,
        changedFields: ['status'],
        requestPayload: { id },
      }),
    );
    return after;
  }

  private validateCreate(input: CreateManualCardSpendEntryInput) {
    const settledSpendUsd = parseDecimalString(input.settledSpendUsd, 'settledSpendUsd');
    const feeRate = parseDecimalString(input.feeRate, 'feeRate');
    const actualSpendUsd = this.calculateActualSpend(settledSpendUsd, feeRate);
    if (input.actualSpendUsd !== undefined) {
      assertDecimalEquals(parseDecimalString(input.actualSpendUsd, 'actualSpendUsd'), actualSpendUsd, 'actualSpendUsd');
    }

    return {
      settlementMonth: parseMonthStart(input.settlementMonth, 'settlementMonth'),
      employeeId: requireNonBlank(input.employeeId, 'employeeId'),
      providerName: requireNonBlank(input.providerName, 'providerName'),
      cardIdentifier: optionalNonBlank(input.cardIdentifier, 'cardIdentifier'),
      settledSpendUsd,
      feeRate,
      actualSpendUsd,
      reason: optionalNonBlank(input.reason, 'reason'),
      status: assertOptionalStatus(input.status, CARD_SPEND_STATUSES) ?? SettlementStatus.draft,
    };
  }

  private validateUpdate(input: UpdateManualCardSpendEntryInput, before: { settledSpendUsd: Prisma.Decimal; feeRate: Prisma.Decimal }) {
    const data: Record<string, unknown> = {};
    if (input.settlementMonth !== undefined) data.settlementMonth = parseMonthStart(input.settlementMonth, 'settlementMonth');
    if (input.employeeId !== undefined) data.employeeId = requireNonBlank(input.employeeId, 'employeeId');
    if (input.providerName !== undefined) data.providerName = requireNonBlank(input.providerName, 'providerName');
    if (input.cardIdentifier !== undefined) data.cardIdentifier = optionalNonBlank(input.cardIdentifier, 'cardIdentifier') ?? null;
    if (input.reason !== undefined) data.reason = optionalNonBlank(input.reason, 'reason') ?? null;
    if (input.status !== undefined) data.status = assertOptionalStatus(input.status, CARD_SPEND_STATUSES);
    if (input.settledSpendUsd !== undefined) data.settledSpendUsd = parseDecimalString(input.settledSpendUsd, 'settledSpendUsd');
    if (input.feeRate !== undefined) data.feeRate = parseDecimalString(input.feeRate, 'feeRate');

    if (input.settledSpendUsd !== undefined || input.feeRate !== undefined || input.actualSpendUsd !== undefined) {
      const settledSpendUsd = (data.settledSpendUsd as Prisma.Decimal | undefined) ?? before.settledSpendUsd;
      const feeRate = (data.feeRate as Prisma.Decimal | undefined) ?? before.feeRate;
      const actualSpendUsd = this.calculateActualSpend(settledSpendUsd, feeRate);
      if (input.actualSpendUsd !== undefined) {
        assertDecimalEquals(parseDecimalString(input.actualSpendUsd, 'actualSpendUsd'), actualSpendUsd, 'actualSpendUsd');
      }
      data.actualSpendUsd = actualSpendUsd;
    }

    return data;
  }

  private calculateActualSpend(settledSpendUsd: Prisma.Decimal, feeRate: Prisma.Decimal): Prisma.Decimal {
    return settledSpendUsd.times(ONE.plus(feeRate));
  }

  private async assertWritable(
    settlementMonth: Date,
    action: string,
    objectId: string | undefined,
    requestPayload: unknown,
    actor: Actor,
  ) {
    await this.monthLock.assertWritable(
      { settlementMonth, action, objectType: 'manual_card_spend_entries', objectId, requestPayload },
      actor,
    );
  }
}
