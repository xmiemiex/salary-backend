import { Injectable } from '@nestjs/common';
import {
  CommonStatus,
  Prisma,
  Provider,
  ProviderCardExclusionReason,
  ProviderCardMatchSource,
  ProviderCardMatchStatus,
} from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import {
  EffectiveSubIdMappingReader,
  isUsableEffectiveSubIdMapping,
  resolveEffectiveSubIdMappings,
} from '../sub-id-mappings/effective-sub-id-mappings';
import {
  emailDigest,
  isValidEmail,
  maskEmail,
  matchProviderCard,
  normalizeEmail,
} from './provider-card-matching';

type Db = PrismaService | Prisma.TransactionClient;
type DateInput = string | Date | null | undefined;

export type AliasWriteInput = {
  groupKey: string;
  employeeId: string;
  validFrom?: DateInput;
  validTo?: DateInput;
  reason?: string;
  confirm?: boolean;
};

export type AliasCorrectionInput = {
  employeeId: string;
  validFrom: DateInput;
  validTo?: DateInput;
  reason?: string;
  confirm?: boolean;
};

export type ExclusionWriteInput = {
  providerCardId: string;
  effectiveFrom?: DateInput;
  effectiveTo?: DateInput;
  note?: string;
  confirm?: boolean;
};

@Injectable()
export class PhotonPayCardGovernanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listUnmatchedGroups() {
    const cards = await this.prisma.providerCard.findMany({
      where: {
        provider: Provider.photonpay,
        matchStatus: ProviderCardMatchStatus.unmatched,
        cardholderEmailNormalized: { not: null },
      },
      select: { cardholderEmailNormalized: true, providerStatus: true },
      orderBy: [{ cardholderEmailNormalized: 'asc' }, { providerStatus: 'asc' }],
    });
    const groups = new Map<string, { email: string; statuses: Record<string, number> }>();
    for (const card of cards) {
      const email = normalizeEmail(card.cardholderEmailNormalized);
      if (!email) continue;
      const group = groups.get(email) ?? { email, statuses: {} };
      const status = normalizeProviderStatus(card.providerStatus);
      group.statuses[status] = (group.statuses[status] ?? 0) + 1;
      groups.set(email, group);
    }
    return {
      groups: [...groups.values()].map((group) => ({
        groupKey: emailDigest(group.email),
        cardholderEmail: group.email,
        maskedEmail: maskEmail(group.email),
        cardCount: sumCounts(group.statuses),
        statusCounts: group.statuses,
      })),
      totalCards: cards.length,
    };
  }

  async safeSummary() {
    const now = new Date();
    const [statusRows, aliasMatchedCount, activeAliasCount, activeExclusions] = await Promise.all([
      this.prisma.providerCard.groupBy({
        by: ['matchStatus'],
        where: { provider: Provider.photonpay },
        _count: { _all: true },
      }),
      this.prisma.providerCard.count({
        where: { provider: Provider.photonpay, matchSource: ProviderCardMatchSource.provider_email_alias },
      }),
      this.prisma.providerEmailAlias.count({
        where: {
          provider: Provider.photonpay,
          status: CommonStatus.active,
          validFrom: { lte: now },
          OR: [{ validTo: null }, { validTo: { gt: now } }],
        },
      }),
      this.prisma.providerCardAccountingExclusion.findMany({
        where: {
          status: CommonStatus.active,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
          providerCard: { provider: Provider.photonpay },
        },
        select: { providerCard: { select: { cardId: true } } },
      }),
    ]);
    const counts = Object.fromEntries(statusRows.map((row) => [row.matchStatus, row._count._all]));
    const excludedCardIds = activeExclusions.map((item) => item.providerCard.cardId);
    const historicalEvents = excludedCardIds.length === 0
      ? []
      : await this.prisma.cardSpendEvent.findMany({
        where: { provider: Provider.photonpay, cardId: { in: excludedCardIds } },
        select: { settlementMonth: true },
      });
    return {
      provider: Provider.photonpay,
      totalCards: sumCounts(counts),
      matched: counts[ProviderCardMatchStatus.matched] ?? 0,
      unmatched: counts[ProviderCardMatchStatus.unmatched] ?? 0,
      conflict: counts[ProviderCardMatchStatus.conflict] ?? 0,
      excluded: counts[ProviderCardMatchStatus.excluded] ?? 0,
      matchedByAlias: aliasMatchedCount,
      activeAliasCount,
      activeExclusionCount: activeExclusions.length,
      excludedCardHistoricalEventCount: historicalEvents.length,
      excludedCardHistoricalMonthCount: new Set(
        historicalEvents.map((event) => event.settlementMonth.toISOString().slice(0, 7)),
      ).size,
    };
  }

  async listEmployeeOptions() {
    return this.prisma.employee.findMany({
      where: { status: CommonStatus.active },
      select: { id: true, employeeCode: true, name: true, status: true },
      orderBy: [{ employeeCode: 'asc' }, { name: 'asc' }],
    });
  }

  async listAliases() {
    const aliases = await this.prisma.providerEmailAlias.findMany({
      where: { provider: Provider.photonpay },
      include: { employee: { select: { id: true, employeeCode: true, name: true, status: true } } },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });
    return {
      items: aliases.map((alias) => ({
        id: alias.id,
        provider: alias.provider,
        aliasEmail: alias.aliasEmailNormalized,
        maskedEmail: maskEmail(alias.aliasEmailNormalized),
        employee: alias.employee,
        status: alias.status,
        validFrom: alias.validFrom,
        validTo: alias.validTo,
        reason: alias.reason,
        createdAt: alias.createdAt,
        updatedAt: alias.updatedAt,
      })),
    };
  }

  async previewAlias(input: AliasWriteInput) {
    const matchingAt = new Date();
    const group = await this.findUnmatchedGroup(input.groupKey);
    const employee = await this.getEmployee(input.employeeId);
    const validFrom = parseDate(input.validFrom, 'validFrom', matchingAt);
    const validTo = parseOptionalDate(input.validTo, 'validTo');
    assertPeriod(validFrom, validTo);
    const overlappingAliases = await this.overlappingAliasesForEmail(group.email, validFrom, validTo);
    const primaryEmployees = await this.prisma.employee.findMany({
      where: { email: { not: null } },
      select: { id: true, email: true, status: true },
    });
    const subMappedEmployeeIds = await this.subMappedEmployeeIds(this.prisma, currentShanghaiSettlementMonth());
    const blockers: string[] = [];
    if (employee.status !== CommonStatus.active) blockers.push('EMPLOYEE_DISABLED');
    if (!subMappedEmployeeIds.has(employee.id)) blockers.push('EMPLOYEE_WITHOUT_SUB');
    if (!isValidEmail(group.email)) blockers.push('CARDHOLDER_EMAIL_INVALID');
    if (overlappingAliases.some((alias) => alias.employeeId !== employee.id)) blockers.push('ALIAS_ASSIGNED_TO_DIFFERENT_EMPLOYEE');
    const idempotentAlias = overlappingAliases.find((alias) => alias.employeeId === employee.id && (
      input.validFrom === undefined || input.validFrom === null || input.validFrom === ''
        ? isEffective(alias.validFrom, alias.validTo, matchingAt)
        : alias.validFrom.getTime() === validFrom.getTime() && sameOptionalDate(alias.validTo, validTo)
    ));
    if (overlappingAliases.length > 0 && !idempotentAlias) blockers.push('ALIAS_PERIOD_OVERLAP');
    if (overlappingAliases.length > 1) blockers.push('PROVIDER_EMAIL_ALIAS_AMBIGUOUS');
    const primaryMatches = primaryEmployees.filter((candidate) => normalizeEmail(candidate.email) === group.email);
    if (primaryMatches.length > 1) blockers.push('EMPLOYEE_EMAIL_AMBIGUOUS');
    if (primaryMatches.length === 1 && primaryMatches[0].id !== employee.id) blockers.push('PRIMARY_EMAIL_ALIAS_CONFLICT');
    return {
      groupKey: input.groupKey,
      maskedEmail: maskEmail(group.email),
      affectedCardCount: group.cards.length,
      statusCounts: group.statusCounts,
      targetEmployee: {
        id: employee.id,
        employeeCode: employee.employeeCode,
        name: employee.name,
        status: employee.status,
      },
      currentSubMappingActive: subMappedEmployeeIds.has(employee.id),
      conflict: blockers.length > 0,
      blockers: [...new Set(blockers)],
      idempotent: Boolean(idempotentAlias),
      validFrom,
      validTo,
    };
  }

  async createAlias(input: AliasWriteInput, actor: Actor) {
    assertConfirmed(input.confirm);
    const preview = await this.previewAlias(input);
    if (preview.conflict) {
      throw new AppError(ERROR_CODES.CONFLICT, 'PhotonPay alias preview contains blockers.', { blockers: preview.blockers });
    }
    const group = await this.findUnmatchedGroup(input.groupKey);
    const matchingAt = new Date();
    const validFrom = parseDate(input.validFrom, 'validFrom', matchingAt);
    const validTo = parseOptionalDate(input.validTo, 'validTo');
    const reason = optionalText(input.reason, 'reason', 2_000);

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.providerEmailAlias.findFirst({
        where: input.validFrom === undefined || input.validFrom === null || input.validFrom === ''
          ? {
            provider: Provider.photonpay,
            aliasEmailNormalized: group.email,
            employeeId: input.employeeId,
            status: CommonStatus.active,
            validFrom: { lte: matchingAt },
            OR: [{ validTo: null }, { validTo: { gt: matchingAt } }],
          }
          : {
            provider: Provider.photonpay,
            aliasEmailNormalized: group.email,
            employeeId: input.employeeId,
            status: CommonStatus.active,
            validFrom,
            validTo,
          },
      });
      if (existing) {
        const rematch = await this.rematchUnmatched(tx, actor, { emails: [group.email] });
        return { alias: existing, rematch, idempotent: true };
      }
      let alias;
      try {
        alias = await tx.providerEmailAlias.create({
          data: {
            provider: Provider.photonpay,
            aliasEmailNormalized: group.email,
            employeeId: input.employeeId,
            status: CommonStatus.active,
            validFrom,
            validTo,
            reason,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          },
        });
      } catch (error) {
        throwAliasConflict(error);
      }
      const rematch = await this.rematchUnmatched(tx, actor, { emails: [group.email] });
      await this.audit.success({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'photonpay_email_alias.create',
        objectType: 'provider_email_aliases',
        objectId: alias.id,
        beforeData: null,
        afterData: safeAliasAudit(alias),
        changedFields: ['provider', 'aliasEmailDigest', 'employeeId', 'status', 'validFrom', 'validTo', 'reason'],
        requestPayload: { groupKey: input.groupKey, employeeId: input.employeeId, confirm: true },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      }, tx);
      return { alias, rematch, idempotent: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return {
      alias: { ...result.alias, aliasEmailNormalized: undefined, maskedEmail: maskEmail(group.email) },
      rematch: result.rematch,
      idempotent: result.idempotent,
    };
  }

  async correctAlias(id: string, input: AliasCorrectionInput, actor: Actor) {
    assertConfirmed(input.confirm);
    const preview = await this.previewAliasCorrection(id, input);
    if (preview.conflict) {
      throw new AppError(ERROR_CODES.CONFLICT, 'PhotonPay alias correction preview contains blockers.', { blockers: preview.blockers });
    }
    const before = await this.getAlias(id);
    if (preview.idempotent) {
      return { maskedEmail: preview.maskedEmail, alias: before, rematch: emptyRematchResult(), idempotent: true };
    }
    const employee = await this.getEmployee(input.employeeId);
    const validFrom = parseDate(input.validFrom, 'validFrom');
    const validTo = parseOptionalDate(input.validTo, 'validTo');
    assertPeriod(validFrom, validTo);
    const reason = optionalText(input.reason, 'reason', 2_000);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.unmatchAliasCards(tx, before.aliasEmailNormalized, actor, 'alias_corrected');
      let alias;
      try {
        alias = await tx.providerEmailAlias.update({
          where: { id },
          data: { employeeId: employee.id, validFrom, validTo, reason, status: CommonStatus.active, updatedBy: actor.userId },
        });
      } catch (error) {
        throwAliasConflict(error);
      }
      const rematch = await this.rematchUnmatched(tx, actor, { emails: [before.aliasEmailNormalized] });
      await this.audit.success({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'photonpay_email_alias.correct',
        objectType: 'provider_email_aliases',
        objectId: id,
        beforeData: safeAliasAudit(before),
        afterData: safeAliasAudit(alias),
        changedFields: ['employeeId', 'validFrom', 'validTo', 'reason', 'status'],
        requestPayload: { employeeId: employee.id, confirm: true },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      }, tx);
      return { alias, rematch };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { maskedEmail: maskEmail(before.aliasEmailNormalized), ...result, idempotent: false };
  }

  async previewAliasCorrection(id: string, input: AliasCorrectionInput) {
    const before = await this.getAlias(id);
    const employee = await this.getEmployee(input.employeeId);
    const validFrom = parseDate(input.validFrom, 'validFrom');
    const validTo = parseOptionalDate(input.validTo, 'validTo');
    assertPeriod(validFrom, validTo);
    const reason = optionalText(input.reason, 'reason', 2_000);
    const [subMapped, overlapping, primaryEmployees, affectedCardCount] = await Promise.all([
      this.subMappedEmployeeIds(this.prisma, currentShanghaiSettlementMonth()),
      this.overlappingAliasesForEmail(before.aliasEmailNormalized, validFrom, validTo),
      this.prisma.employee.findMany({
        where: { email: { not: null } },
        select: { id: true, email: true },
      }),
      this.prisma.providerCard.count({
        where: {
          provider: Provider.photonpay,
          cardholderEmailNormalized: before.aliasEmailNormalized,
          matchStatus: ProviderCardMatchStatus.matched,
          matchSource: ProviderCardMatchSource.provider_email_alias,
        },
      }),
    ]);
    const blockers: string[] = [];
    if (employee.status !== CommonStatus.active) blockers.push('EMPLOYEE_DISABLED');
    if (!subMapped.has(employee.id)) blockers.push('EMPLOYEE_WITHOUT_SUB');
    if (overlapping.some((alias) => alias.id !== before.id)) blockers.push('ALIAS_PERIOD_OVERLAP');
    const primaryMatches = primaryEmployees.filter((candidate) => normalizeEmail(candidate.email) === before.aliasEmailNormalized);
    if (primaryMatches.length > 1) blockers.push('EMPLOYEE_EMAIL_AMBIGUOUS');
    if (primaryMatches.length === 1 && primaryMatches[0].id !== employee.id) blockers.push('PRIMARY_EMAIL_ALIAS_CONFLICT');
    const idempotent = before.status === CommonStatus.active
      && before.employeeId === employee.id
      && before.validFrom.getTime() === validFrom.getTime()
      && sameOptionalDate(before.validTo, validTo)
      && before.reason === reason;
    return {
      id,
      maskedEmail: maskEmail(before.aliasEmailNormalized),
      affectedCardCount,
      targetEmployee: { id: employee.id, employeeCode: employee.employeeCode, name: employee.name, status: employee.status },
      currentSubMappingActive: subMapped.has(employee.id),
      conflict: blockers.length > 0,
      blockers: [...new Set(blockers)],
      idempotent,
      validFrom,
      validTo,
    };
  }

  async disableAlias(id: string, input: { confirm?: boolean }, actor: Actor) {
    assertConfirmed(input.confirm);
    const before = await this.getAlias(id);
    if (before.status === CommonStatus.disabled) return { id, idempotent: true, affectedCardCount: 0 };
    const { affectedCardCount } = await this.previewDisableAlias(id);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.unmatchAliasCards(tx, before.aliasEmailNormalized, actor, 'alias_disabled');
      const alias = await tx.providerEmailAlias.update({
        where: { id },
        data: { status: CommonStatus.disabled, updatedBy: actor.userId },
      });
      const rematch = await this.rematchUnmatched(tx, actor, { emails: [before.aliasEmailNormalized] });
      await this.audit.success({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'photonpay_email_alias.disable',
        objectType: 'provider_email_aliases',
        objectId: id,
        beforeData: safeAliasAudit(before),
        afterData: safeAliasAudit(alias),
        changedFields: ['status'],
        requestPayload: { confirm: true, affectedCardCount },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      }, tx);
      return { rematch };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { id, idempotent: false, affectedCardCount, ...result };
  }

  async previewDisableAlias(id: string) {
    const alias = await this.getAlias(id);
    const affectedCardCount = await this.prisma.providerCard.count({
      where: {
        provider: Provider.photonpay,
        cardholderEmailNormalized: alias.aliasEmailNormalized,
        matchStatus: ProviderCardMatchStatus.matched,
        matchSource: ProviderCardMatchSource.provider_email_alias,
      },
    });
    return { id, maskedEmail: maskEmail(alias.aliasEmailNormalized), affectedCardCount, status: alias.status };
  }

  async previewRematch() {
    return this.rematchUnmatched(this.prisma, null, { preview: true });
  }

  async executeRematch(input: { confirm?: boolean }, actor: Actor) {
    assertConfirmed(input.confirm);
    return this.prisma.$transaction(
      async (tx) => {
        const result = await this.rematchUnmatched(tx, actor, {});
        if (result.changedCount > 0) await this.audit.success({
          actorUserId: actor.userId,
          actorRole: actor.roleCode,
          action: 'photonpay_provider_card.rematch',
          objectType: 'provider_cards',
          afterData: result,
          changedFields: ['matchStatus', 'matchSource', 'employeeId', 'unmatchedReasonCode'],
          requestPayload: { confirm: true },
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        }, tx);
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async listExclusions() {
    const items = await this.prisma.providerCardAccountingExclusion.findMany({
      include: { providerCard: { select: { id: true, provider: true, maskedCardNumber: true, nickname: true, providerStatus: true } } },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });
    return { items };
  }

  async previewExclusion(input: ExclusionWriteInput) {
    const effectiveFrom = parseDate(input.effectiveFrom, 'effectiveFrom', new Date());
    const effectiveTo = parseOptionalDate(input.effectiveTo, 'effectiveTo');
    assertPeriod(effectiveFrom, effectiveTo);
    const card = await this.prisma.providerCard.findUnique({
      where: { id: requireText(input.providerCardId, 'providerCardId', 64) },
      select: { id: true, provider: true, maskedCardNumber: true, nickname: true, providerStatus: true, matchStatus: true },
    });
    if (!card || card.provider !== Provider.photonpay) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'A discovered PhotonPay card was not found.');
    }
    const eventWhere: Prisma.CardSpendEventWhereInput = {
      provider: Provider.photonpay,
      cardId: (await this.prisma.providerCard.findUniqueOrThrow({ where: { id: card.id }, select: { cardId: true } })).cardId,
    };
    const [existingEventCount, amount, months] = await Promise.all([
      this.prisma.cardSpendEvent.count({ where: eventWhere }),
      this.prisma.cardSpendEvent.aggregate({ where: eventWhere, _sum: { spendUsd: true } }),
      this.prisma.cardSpendEvent.groupBy({ by: ['settlementMonth'], where: eventWhere, _count: { _all: true }, orderBy: { settlementMonth: 'asc' } }),
    ]);
    return {
      providerCardId: card.id,
      card: {
        maskedCardNumber: card.maskedCardNumber,
        nickname: card.nickname,
        providerStatus: card.providerStatus,
        matchStatus: card.matchStatus,
      },
      reason: ProviderCardExclusionReason.admin_test_card,
      effectiveFrom,
      effectiveTo,
      existingCardSpendEventCount: existingEventCount,
      existingSpendUsd: amount._sum.spendUsd?.toString() ?? '0',
      existingMonths: months.map((row) => ({ month: row.settlementMonth.toISOString().slice(0, 7), count: row._count._all })),
      canApply: existingEventCount === 0,
      blocker: existingEventCount > 0 ? 'EXISTING_CARD_SPEND_EVENTS_REQUIRE_PRODUCT_DECISION' : null,
    };
  }

  async createExclusion(input: ExclusionWriteInput, actor: Actor) {
    assertConfirmed(input.confirm);
    const preview = await this.previewExclusion(input);
    if (!preview.canApply) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Existing card spend events require a product decision before exclusion.', {
        existingCardSpendEventCount: preview.existingCardSpendEventCount,
        existingMonths: preview.existingMonths,
      });
    }
    const note = optionalText(input.note, 'note', 2_000);
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.providerCardAccountingExclusion.findFirst({
        where: input.effectiveFrom === undefined || input.effectiveFrom === null || input.effectiveFrom === ''
          ? {
            providerCardId: preview.providerCardId,
            reason: ProviderCardExclusionReason.admin_test_card,
            status: CommonStatus.active,
            effectiveFrom: { lte: new Date() },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
          }
          : {
            providerCardId: preview.providerCardId,
            reason: ProviderCardExclusionReason.admin_test_card,
            status: CommonStatus.active,
            effectiveFrom: preview.effectiveFrom,
            effectiveTo: preview.effectiveTo,
          },
      });
      if (existing) return { exclusion: existing, idempotent: true };
      let exclusion;
      try {
        exclusion = await tx.providerCardAccountingExclusion.create({
          data: {
            providerCardId: preview.providerCardId,
            reason: ProviderCardExclusionReason.admin_test_card,
            status: CommonStatus.active,
            effectiveFrom: preview.effectiveFrom,
            effectiveTo: preview.effectiveTo,
            note,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          },
        });
      } catch (error) {
        throwExclusionConflict(error);
      }
      const before = await tx.providerCard.findUniqueOrThrow({ where: { id: preview.providerCardId } });
      const now = new Date();
      if (isEffective(exclusion.effectiveFrom, exclusion.effectiveTo, now)) {
        await tx.providerCard.update({
          where: { id: preview.providerCardId },
          data: {
            employeeId: null,
            matchStatus: ProviderCardMatchStatus.excluded,
            matchSource: null,
            unmatchedReasonCode: 'ADMIN_TEST_CARD',
          },
        });
        await tx.providerCardMatchResolution.create({
          data: {
            providerCardId: before.id,
            resolutionType: 'admin_test_card',
            previousMatchStatus: before.matchStatus,
            previousReasonCode: before.unmatchedReasonCode,
            newMatchStatus: ProviderCardMatchStatus.excluded,
            newReasonCode: 'ADMIN_TEST_CARD',
            exclusionId: exclusion.id,
            resolvedBy: actor.userId,
            safeMetadata: { provider: Provider.photonpay, providerCardDigest: idDigest(before.id) },
          },
        });
      }
      await this.audit.success({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'provider_card_accounting_exclusion.create',
        objectType: 'provider_card_accounting_exclusions',
        objectId: exclusion.id,
        beforeData: null,
        afterData: safeExclusionAudit(exclusion),
        changedFields: ['providerCardDigest', 'reason', 'status', 'effectiveFrom', 'effectiveTo', 'note'],
        requestPayload: { providerCardDigest: idDigest(preview.providerCardId), confirm: true },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      }, tx);
      return { exclusion, idempotent: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { ...result, preview };
  }

  async disableExclusion(id: string, input: { confirm?: boolean }, actor: Actor) {
    assertConfirmed(input.confirm);
    const before = await this.prisma.providerCardAccountingExclusion.findUnique({ where: { id } });
    if (!before) throw new AppError(ERROR_CODES.NOT_FOUND, 'Card accounting exclusion not found.');
    if (before.status === CommonStatus.disabled) return { id, idempotent: true };
    return this.prisma.$transaction(async (tx) => {
      const exclusion = await tx.providerCardAccountingExclusion.update({
        where: { id },
        data: { status: CommonStatus.disabled, updatedBy: actor.userId },
      });
      const card = await tx.providerCard.findUniqueOrThrow({ where: { id: before.providerCardId } });
      let rematch = emptyRematchResult();
      if (card.matchStatus === ProviderCardMatchStatus.excluded) {
        await tx.providerCard.update({
          where: { id: card.id },
          data: { matchStatus: ProviderCardMatchStatus.unmatched, matchSource: null, employeeId: null, unmatchedReasonCode: 'EXCLUSION_DISABLED' },
        });
        await tx.providerCardMatchResolution.create({
          data: {
            providerCardId: card.id,
            resolutionType: 'exclusion_disabled',
            previousMatchStatus: card.matchStatus,
            previousReasonCode: card.unmatchedReasonCode,
            newMatchStatus: ProviderCardMatchStatus.unmatched,
            newReasonCode: 'EXCLUSION_DISABLED',
            exclusionId: before.id,
            resolvedBy: actor.userId,
            safeMetadata: { provider: Provider.photonpay, providerCardDigest: idDigest(card.id) },
          },
        });
        rematch = await this.rematchUnmatched(tx, actor, { cardIds: [card.id] });
      }
      await this.audit.success({
        actorUserId: actor.userId,
        actorRole: actor.roleCode,
        action: 'provider_card_accounting_exclusion.disable',
        objectType: 'provider_card_accounting_exclusions',
        objectId: id,
        beforeData: safeExclusionAudit(before),
        afterData: safeExclusionAudit(exclusion),
        changedFields: ['status'],
        requestPayload: { providerCardDigest: idDigest(before.providerCardId), confirm: true },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      }, tx);
      return { id, idempotent: false, rematch };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async rematchUnmatched(
    db: Db,
    actor: Actor | null,
    options: { emails?: string[]; cardIds?: string[]; preview?: boolean },
  ) {
    const matchingAt = new Date();
    const cards = await db.providerCard.findMany({
      where: {
        provider: Provider.photonpay,
        matchStatus: ProviderCardMatchStatus.unmatched,
        ...(options.emails ? { cardholderEmailNormalized: { in: options.emails } } : {}),
        ...(options.cardIds ? { id: { in: options.cardIds } } : {}),
      },
      select: {
        id: true,
        cardholderEmailNormalized: true,
        employeeId: true,
        matchStatus: true,
        matchSource: true,
        unmatchedReasonCode: true,
      },
      orderBy: { id: 'asc' },
    });
    const employees = await db.employee.findMany({ select: { id: true, email: true, status: true } });
    const aliases = await db.providerEmailAlias.findMany({
      where: {
        provider: Provider.photonpay,
        status: CommonStatus.active,
        validFrom: { lte: matchingAt },
        OR: [{ validTo: null }, { validTo: { gt: matchingAt } }],
      },
      select: { id: true, provider: true, aliasEmailNormalized: true, employeeId: true, status: true, validFrom: true, validTo: true },
    });
    const subMappedEmployeeIds = await this.subMappedEmployeeIds(db, currentShanghaiSettlementMonth());
    const exclusions = await db.providerCardAccountingExclusion.findMany({
      where: {
        providerCardId: { in: cards.map((card) => card.id) },
        status: CommonStatus.active,
        effectiveFrom: { lte: matchingAt },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: matchingAt } }],
      },
      select: { id: true, providerCardId: true },
    });
    const exclusionByCard = new Map(exclusions.map((item) => [item.providerCardId, item]));
    const stats = emptyRematchResult();
    for (const card of cards) {
      stats.processedCount += 1;
      const exclusion = exclusionByCard.get(card.id);
      const match = exclusion
        ? {
          employeeId: null,
          status: ProviderCardMatchStatus.excluded,
          source: null,
          reasonCode: 'ADMIN_TEST_CARD',
          aliasId: null,
        }
        : matchProviderCard({
          provider: Provider.photonpay,
          email: card.cardholderEmailNormalized,
          employees,
          aliases,
          subMappedEmployeeIds,
          matchingAt,
        });
      incrementRematchStats(stats, match.status, match.source, match.reasonCode);
      if (options.preview) continue;
      const changed = card.employeeId !== match.employeeId
        || card.matchStatus !== match.status
        || card.matchSource !== match.source
        || card.unmatchedReasonCode !== match.reasonCode;
      if (!changed) continue;
      stats.changedCount += 1;
      await db.providerCard.update({
        where: { id: card.id },
        data: {
          employeeId: match.employeeId,
          matchStatus: match.status,
          matchSource: match.source,
          unmatchedReasonCode: match.reasonCode,
        },
      });
      if (actor && (match.status === ProviderCardMatchStatus.matched || match.status === ProviderCardMatchStatus.excluded)) {
        await db.providerCardMatchResolution.create({
          data: {
            providerCardId: card.id,
            resolutionType: match.status === ProviderCardMatchStatus.excluded ? 'admin_test_card' : match.source!,
            previousMatchStatus: card.matchStatus,
            previousReasonCode: card.unmatchedReasonCode,
            newMatchStatus: match.status,
            newReasonCode: match.reasonCode,
            employeeId: match.employeeId,
            aliasId: match.aliasId,
            exclusionId: exclusion?.id,
            resolvedBy: actor.userId,
            safeMetadata: {
              provider: Provider.photonpay,
              providerCardDigest: idDigest(card.id),
              emailDigest: card.cardholderEmailNormalized ? emailDigest(card.cardholderEmailNormalized) : null,
            },
          },
        });
        stats.resolvedExceptionCount += 1;
      }
    }
    return stats;
  }

  private async unmatchAliasCards(db: Db, email: string, actor: Actor, resolutionType: string) {
    const cards = await db.providerCard.findMany({
      where: {
        provider: Provider.photonpay,
        cardholderEmailNormalized: email,
        matchStatus: ProviderCardMatchStatus.matched,
        matchSource: ProviderCardMatchSource.provider_email_alias,
      },
    });
    for (const card of cards) {
      await db.providerCard.update({
        where: { id: card.id },
        data: { employeeId: null, matchStatus: ProviderCardMatchStatus.unmatched, matchSource: null, unmatchedReasonCode: resolutionType.toUpperCase() },
      });
      await db.providerCardMatchResolution.create({
        data: {
          providerCardId: card.id,
          resolutionType,
          previousMatchStatus: card.matchStatus,
          previousReasonCode: card.unmatchedReasonCode,
          newMatchStatus: ProviderCardMatchStatus.unmatched,
          newReasonCode: resolutionType.toUpperCase(),
          resolvedBy: actor.userId,
          safeMetadata: { provider: Provider.photonpay, providerCardDigest: idDigest(card.id), emailDigest: emailDigest(email) },
        },
      });
    }
    return cards.length;
  }

  private async findUnmatchedGroup(groupKey: string) {
    const key = requireText(groupKey, 'groupKey', 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'groupKey is invalid.');
    const cards = await this.prisma.providerCard.findMany({
      where: { provider: Provider.photonpay, cardholderEmailNormalized: { not: null } },
      select: { id: true, cardholderEmailNormalized: true, providerStatus: true, matchStatus: true },
    });
    const emailCards = cards.filter((card) => card.cardholderEmailNormalized && emailDigest(card.cardholderEmailNormalized) === key);
    if (!emailCards.length) throw new AppError(ERROR_CODES.NOT_FOUND, 'PhotonPay email group not found.');
    const email = normalizeEmail(emailCards[0].cardholderEmailNormalized)!;
    const matched = emailCards.filter((card) => card.matchStatus === ProviderCardMatchStatus.unmatched);
    const statusCounts: Record<string, number> = {};
    for (const card of matched) {
      const status = normalizeProviderStatus(card.providerStatus);
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }
    return { email, cards: matched, statusCounts };
  }

  private getEmployee(id: string) {
    return this.prisma.employee.findUnique({
      where: { id: requireText(id, 'employeeId', 64) },
      select: { id: true, employeeCode: true, name: true, email: true, status: true },
    }).then((employee) => {
      if (!employee) throw new AppError(ERROR_CODES.NOT_FOUND, 'Employee not found.');
      return employee;
    });
  }

  private getAlias(id: string) {
    return this.prisma.providerEmailAlias.findUnique({ where: { id: requireText(id, 'id', 64) } }).then((alias) => {
      if (!alias || alias.provider !== Provider.photonpay) throw new AppError(ERROR_CODES.NOT_FOUND, 'PhotonPay email alias not found.');
      return alias;
    });
  }

  private overlappingAliasesForEmail(email: string, from: Date, to: Date | null) {
    return this.prisma.providerEmailAlias.findMany({
      where: {
        provider: Provider.photonpay,
        aliasEmailNormalized: email,
        status: CommonStatus.active,
        ...(to ? { validFrom: { lt: to } } : {}),
        OR: [{ validTo: null }, { validTo: { gt: from } }],
      },
    });
  }

  private async subMappedEmployeeIds(db: Db, settlementMonth: Date) {
    const mappings = await resolveEffectiveSubIdMappings(db as unknown as EffectiveSubIdMappingReader, { settlementMonth });
    return new Set(mappings.filter(isUsableEffectiveSubIdMapping).map((mapping) => mapping.employeeId));
  }
}

function emptyRematchResult() {
  return {
    matchedByPrimaryEmail: 0,
    matchedByAlias: 0,
    excluded: 0,
    remainingUnmatched: 0,
    conflict: 0,
    employeeDisabled: 0,
    employeeWithoutSub: 0,
    missingId: 0,
    resolvedExceptionCount: 0,
    processedCount: 0,
    changedCount: 0,
  };
}

function incrementRematchStats(
  stats: ReturnType<typeof emptyRematchResult>,
  status: ProviderCardMatchStatus,
  source: ProviderCardMatchSource | null,
  reasonCode: string | null,
) {
  if (status === ProviderCardMatchStatus.excluded) stats.excluded += 1;
  else if (status === ProviderCardMatchStatus.conflict) stats.conflict += 1;
  else if (status === ProviderCardMatchStatus.matched && source === ProviderCardMatchSource.employee_primary_email) stats.matchedByPrimaryEmail += 1;
  else if (status === ProviderCardMatchStatus.matched && source === ProviderCardMatchSource.provider_email_alias) stats.matchedByAlias += 1;
  else stats.remainingUnmatched += 1;
  if (reasonCode === 'EMPLOYEE_DISABLED') stats.employeeDisabled += 1;
  if (reasonCode === 'EMPLOYEE_WITHOUT_SUB') stats.employeeWithoutSub += 1;
  if (reasonCode === 'CARD_ID_MISSING') stats.missingId += 1;
}

function normalizeProviderStatus(value: string | null) {
  const normalized = value?.trim().toLowerCase() ?? 'unknown';
  if (normalized === 'closed') return 'cancelled';
  if (normalized === 'active') return 'normal';
  return normalized || 'unknown';
}

function sumCounts(counts: Record<string, number>) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function currentShanghaiSettlementMonth(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1));
}

function parseDate(value: DateInput, field: string, defaultValue?: Date) {
  if (value === undefined || value === null || value === '') {
    if (defaultValue) return defaultValue;
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is required.`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} must be a valid date.`);
  return date;
}

function parseOptionalDate(value: DateInput, field: string) {
  if (value === undefined || value === null || value === '') return null;
  return parseDate(value, field);
}

function assertPeriod(from: Date, to: Date | null) {
  if (to && to <= from) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'The effective end must be after the start.');
}

function assertConfirmed(value: boolean | undefined) {
  if (value !== true) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Explicit confirmation is required.');
}

function requireText(value: unknown, field: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${field} is invalid.`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, max: number) {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, field, max);
}

function isEffective(from: Date, to: Date | null, at: Date) {
  return from <= at && (!to || to > at);
}

function sameOptionalDate(left: Date | null, right: Date | null) {
  return left === null ? right === null : right !== null && left.getTime() === right.getTime();
}

function idDigest(value: string) {
  return emailDigest(`provider-card:${value}`);
}

function safeAliasAudit(alias: {
  id: string;
  provider: Provider;
  aliasEmailNormalized: string;
  employeeId: string;
  status: CommonStatus;
  validFrom: Date;
  validTo: Date | null;
  reason: string | null;
}) {
  return {
    id: alias.id,
    provider: alias.provider,
    aliasEmailDigest: emailDigest(alias.aliasEmailNormalized),
    maskedEmail: maskEmail(alias.aliasEmailNormalized),
    employeeId: alias.employeeId,
    status: alias.status,
    validFrom: alias.validFrom,
    validTo: alias.validTo,
    reasonPresent: alias.reason !== null,
    reasonDigest: alias.reason ? emailDigest(`alias-reason:${alias.reason}`) : null,
  };
}

function safeExclusionAudit(exclusion: {
  id: string;
  providerCardId: string;
  reason: ProviderCardExclusionReason;
  status: CommonStatus;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  note: string | null;
}) {
  return {
    id: exclusion.id,
    providerCardDigest: idDigest(exclusion.providerCardId),
    reason: exclusion.reason,
    status: exclusion.status,
    effectiveFrom: exclusion.effectiveFrom,
    effectiveTo: exclusion.effectiveTo,
    notePresent: exclusion.note !== null,
    noteDigest: exclusion.note ? emailDigest(`exclusion-note:${exclusion.note}`) : null,
  };
}

function throwAliasConflict(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError || String(error).includes('overlaps an active alias')) {
    throw new AppError(ERROR_CODES.CONFLICT, 'PhotonPay alias overlaps an existing active alias.');
  }
  throw error;
}

function throwExclusionConflict(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError || String(error).includes('overlaps an active exclusion')) {
    throw new AppError(ERROR_CODES.CONFLICT, 'Card exclusion overlaps an existing active exclusion.');
  }
  throw error;
}
