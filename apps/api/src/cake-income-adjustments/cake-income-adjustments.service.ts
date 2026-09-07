import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CommonStatus, Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { parseDecimalString, parseMonthStart, requireNonBlank } from '../base-data/base-data.utils';
import { AppError } from '../common/app-error';
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';
import { readCakeMonthlyReview } from './cake-monthly-review';
import {
  EffectiveSubIdMappingReader,
  isActiveEffectiveSubIdMapping,
  resolveEffectiveSubIdMappings,
} from '../sub-id-mappings/effective-sub-id-mappings';
import {
  buildCakeAdjustmentMetadata,
  CAKE_ADJUSTMENT_SOURCE,
  CAKE_BASE_SOURCE,
  cakeAdjustmentExternalRecordId,
  CAKE_SUB_FIELD,
  readCakeAdjustmentMetadata,
} from './cake-income-adjustment.utils';

const MAX_REASON_LENGTH = 1000;

export type CakeIncomeAdjustmentQuery = {
  affiliateAccountId?: string;
  settlementMonth?: string;
};

export type SaveCakeIncomeAdjustmentInput = {
  affiliateAccountId: string;
  settlementMonth: string | Date;
  subValue: string;
  actualRevenueUsd: string;
  reason: string;
};

export type CakeMonthlyReviewInput = {
  affiliateAccountId: string;
  settlementMonth: string;
  baseFingerprint?: string;
};

export type CakeBatchInput = {
  affiliateAccountId: string;
  settlementMonth: string;
  requestId: string;
  items: { id: string; updatedAt: string }[];
};

@Injectable()
export class CakeIncomeAdjustmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly monthLock: MonthLockService,
    private readonly audit: AuditService,
  ) {}

  async list(query: CakeIncomeAdjustmentQuery, actor: Actor) {
    this.assertSuperAdmin(actor);
    const affiliateAccountId = requireNonBlank(query.affiliateAccountId, 'affiliateAccountId');
    const settlementMonth = parseMonthStart(query.settlementMonth, 'settlementMonth');
    const account = await this.getCakeAccount(affiliateAccountId);
    const [baseRows, adjustments, mappings, locked] = await Promise.all([
      this.prisma.incomeRecord.findMany({
        where: { affiliateAccountId, settlementMonth, source: CAKE_BASE_SOURCE, status: CommonStatus.confirmed, subField: CAKE_SUB_FIELD },
        select: { id: true, employeeId: true, subValue: true, incomeUsd: true },
      }),
      this.prisma.incomeRecord.findMany({
        where: { affiliateAccountId, settlementMonth, source: CAKE_ADJUSTMENT_SOURCE, subField: CAKE_SUB_FIELD },
        select: {
          id: true,
          employeeId: true,
          subValue: true,
          incomeUsd: true,
          rawData: true,
          status: true,
          importedBy: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      resolveEffectiveSubIdMappings(this.prisma as unknown as EffectiveSubIdMappingReader, {
        affiliateAccountId,
        settlementMonth,
        subField: CAKE_SUB_FIELD,
      }),
      this.monthLock.isLocked(settlementMonth),
    ]);

    const keys = new Set<string>();
    baseRows.forEach((row) => { if (row.subValue?.trim()) keys.add(row.subValue.trim()); });
    mappings.forEach((row) => { if (row.subValue.trim()) keys.add(row.subValue.trim()); });
    adjustments.forEach((row) => { if (row.subValue?.trim()) keys.add(row.subValue.trim()); });

    const items = [...keys].sort().map((subValue) => {
      const subBaseRows = baseRows.filter((row) => row.subValue === subValue);
      const baseRevenue = sum(subBaseRows.map((row) => row.incomeUsd));
      const mappingRows = mappings.filter((row) => row.subValue === subValue && isActiveEffectiveSubIdMapping(row));
      const employeeIds = [...new Set(mappingRows.map((row) => row.employeeId))];
      const adjustment = adjustments.find((row) => row.subValue === subValue) ?? null;
      const metadata = readCakeAdjustmentMetadata(adjustment?.rawData);
      const mappingStatus = employeeIds.length === 0 ? 'missing' : employeeIds.length > 1 ? 'conflict' : 'matched';
      const employee = mappingStatus === 'matched' ? mappingRows.find((row) => row.employeeId === employeeIds[0])?.employee : null;
      const baseEmployeeIds = [...new Set(subBaseRows.map((row) => row.employeeId).filter((value): value is string => Boolean(value)))];
      const employeeMismatch = mappingStatus === 'matched' && baseEmployeeIds.some((id) => id !== employeeIds[0]);
      const confirmedAdjustment = adjustment?.status === CommonStatus.confirmed ? adjustment.incomeUsd : new Prisma.Decimal(0);
      const previewAdjustment = adjustment?.incomeUsd ?? new Prisma.Decimal(0);

      return {
        id: adjustment?.id ?? null,
        affiliateAccountId,
        settlementMonth: formatMonth(settlementMonth),
        subField: CAKE_SUB_FIELD,
        subValue,
        employeeId: mappingStatus === 'matched' ? employeeIds[0] : null,
        employeeCode: employee?.employeeCode ?? null,
        employeeName: employee?.name ?? null,
        employeeStatus: employee?.status ?? null,
        mappingStatus,
        employeeMismatch,
        baseRecordPresent: subBaseRows.length > 0,
        baseRevenueUsd: baseRevenue.toString(),
        adjustmentUsd: adjustment?.incomeUsd.toString() ?? '0',
        confirmedAdjustmentUsd: confirmedAdjustment.toString(),
        finalRevenueUsd: baseRevenue.plus(confirmedAdjustment).toString(),
        previewRevenueUsd: baseRevenue.plus(previewAdjustment).toString(),
        actualRevenueUsd: metadata?.targetRevenueUsd ?? null,
        reason: metadata?.reason ?? null,
        stale: metadata?.stale ?? false,
        staleReason: metadata?.staleReason ?? null,
        previousBaseRevenueUsd: metadata?.previousBaseRevenueUsd ?? null,
        currentBaseRevenueUsd: metadata?.currentBaseRevenueUsd ?? null,
        status: adjustment?.status ?? null,
        importedBy: adjustment?.importedBy ?? null,
        createdAt: adjustment?.createdAt ?? null,
        updatedAt: adjustment?.updatedAt ?? null,
        editable: !locked
          && subBaseRows.length > 0
          && mappingStatus === 'matched'
          && !employeeMismatch
          && employee?.status === CommonStatus.active,
      };
    });

    const baseTotal = sum(baseRows.map((row) => row.incomeUsd));
    const confirmedAdjustmentTotal = sum(adjustments.filter((row) => row.status === CommonStatus.confirmed).map((row) => row.incomeUsd));
    return {
      account: { id: account.id, platform: account.platform, accountCode: account.accountCode, accountName: account.accountName },
      settlementMonth: formatMonth(settlementMonth),
      providerTimezone: 'cake_system_default',
      settlementTimezone: 'Asia/Shanghai',
      timezoneVerified: false,
      adjustmentBasis: 'manual_china_standard_time',
      locked,
      review: await readCakeMonthlyReview(this.prisma, affiliateAccountId, settlementMonth),
      items,
      summary: {
        baseRevenueUsd: baseTotal.toString(),
        confirmedAdjustmentUsd: confirmedAdjustmentTotal.toString(),
        finalRevenueUsd: baseTotal.plus(confirmedAdjustmentTotal).toString(),
        confirmedAdjustmentCount: adjustments.filter((row) => row.status === CommonStatus.confirmed).length,
        draftAdjustmentCount: adjustments.filter((row) => row.status === CommonStatus.draft).length,
      },
    };
  }

  async confirmMonthlyReview(input: CakeMonthlyReviewInput, actor: Actor) {
    return this.writeMonthlyReview(input, actor, true);
  }

  async cancelMonthlyReview(input: CakeMonthlyReviewInput, actor: Actor) {
    return this.writeMonthlyReview(input, actor, false);
  }

  async batch(input: CakeBatchInput, operation: 'confirm' | 'disable', actor: Actor) {
    this.assertSuperAdmin(actor);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(input.affiliateAccountId ?? '') || !uuid.test(input.requestId ?? '') || !Array.isArray(input.items)
      || input.items.length < 1 || input.items.length > 200
      || input.items.some(item => !item || !uuid.test(item.id ?? '') || typeof item.updatedAt !== 'string' || Number.isNaN(Date.parse(item.updatedAt)))
      || new Set(input.items.map(item => item.id)).size !== input.items.length) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '请选择1至200条不重复记录，并提供有效的版本和批次标识。');
    }
    const settlementMonth = parseMonthStart(input.settlementMonth, 'settlementMonth');
    const action = `cake_income_adjustment.batch_${operation}`;
    const selectionDigest = createHash('sha256').update(JSON.stringify({ affiliateAccountId: input.affiliateAccountId, month: settlementMonth.toISOString(), operation, items: [...input.items].sort((a, b) => a.id.localeCompare(b.id)) })).digest('hex');
    await this.monthLock.assertWritable({ settlementMonth, action, objectType: 'income_records', requestPayload: { requestId: input.requestId } }, actor);
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`monthly-finance:${settlementMonth.toISOString()}`}, 0))`;
      if ((await tx.monthlySettlement.findUnique({ where: { settlementMonth } }))?.status === 'locked') throw new AppError(ERROR_CODES.MONTH_LOCKED, '本月已锁账，不能批量处理调整。');
      await this.getCakeAccount(input.affiliateAccountId, tx);
      const previous = await tx.auditLog.findFirst({ where: { actorUserId: actor.userId, action, objectId: input.affiliateAccountId, settlementMonth, result: 'success', requestPayload: { path: ['requestId'], equals: input.requestId } } });
      if (previous) {
        if ((previous.requestPayload as Record<string, unknown>)?.selectionDigest !== selectionDigest) throw new AppError(ERROR_CODES.CONFLICT, '批次标识已用于其他选择，请重新选择后提交。');
        return { processed: input.items.length, operation, reused: true };
      }
      const rows = await tx.incomeRecord.findMany({ where: { id: { in: input.items.map(item => item.id) }, affiliateAccountId: input.affiliateAccountId, settlementMonth, source: CAKE_ADJUSTMENT_SOURCE } });
      if (rows.length !== input.items.length) throw new AppError(ERROR_CODES.CONFLICT, '所选记录不存在或不属于当前联盟账号及月份，整批未处理。');
      // Validate every item before writing any item, then persist all changes and audits atomically.
      const changes: { before: typeof rows[number]; data: Prisma.IncomeRecordUpdateInput }[] = [];
      for (const row of rows) {
        const selected = input.items.find(item => item.id === row.id)!;
        if (Date.parse(selected.updatedAt) !== row.updatedAt.getTime()) throw new AppError(ERROR_CODES.CONFLICT, `SUB ${row.subValue ?? '-'} 的记录已变化，请刷新后重新选择；整批未处理。`);
        if (operation === 'disable') {
          if (row.status !== 'draft' && row.status !== 'confirmed') throw new AppError(ERROR_CODES.CONFLICT, `SUB ${row.subValue ?? '-'} 不是可停用的草稿或已确认记录；整批未处理。`);
          changes.push({ before: row, data: { status: 'disabled' } });
          continue;
        }
        const metadata = readCakeAdjustmentMetadata(row.rawData);
        if (row.status !== 'draft' || !metadata || metadata.stale || !row.subValue) throw new AppError(ERROR_CODES.CONFLICT, `SUB ${row.subValue ?? '-'} 不是有效草稿或需要重新编辑基准；整批未处理。`);
        const resolved = await this.resolveInput({ affiliateAccountId: input.affiliateAccountId, settlementMonth, subValue: row.subValue, actualRevenueUsd: metadata.targetRevenueUsd, reason: metadata.reason }, tx);
        if (!resolved.baseRevenueUsd.equals(metadata.baseRevenueUsd) || !resolved.adjustmentUsd.equals(row.incomeUsd) || resolved.employeeId !== row.employeeId || resolved.adjustmentUsd.isZero()) throw new AppError(ERROR_CODES.CONFLICT, `SUB ${row.subValue} 的基础收入、归属或差额已变化，请重新保存草稿；整批未处理。`);
        changes.push({ before: row, data: { status: 'confirmed', importedBy: actor.userId, rawData: buildCakeAdjustmentMetadata(resolved) as unknown as Prisma.InputJsonObject } });
      }
      for (const change of changes) {
        const after = await tx.incomeRecord.update({ where: { id: change.before.id }, data: change.data });
        await this.audit.success({ actorUserId: actor.userId, actorRole: actor.roleCode, action: `cake_income_adjustment.${operation}`, objectType: 'income_records', objectId: after.id, settlementMonth, beforeData: change.before, afterData: after, changedFields: Object.keys(change.data), requestPayload: { requestId: input.requestId, batch: true }, ipAddress: actor.ipAddress, userAgent: actor.userAgent }, tx);
      }
      await this.audit.success({ actorUserId: actor.userId, actorRole: actor.roleCode, action, objectType: 'income_records', objectId: input.affiliateAccountId, settlementMonth, afterData: { processed: rows.length, operation }, requestPayload: { requestId: input.requestId, selectionDigest }, changedFields: ['status'], ipAddress: actor.ipAddress, userAgent: actor.userAgent }, tx);
      return { processed: rows.length, operation, reused: false };
    }, { timeout: 30000 });
  }

  private async writeMonthlyReview(input: CakeMonthlyReviewInput, actor: Actor, confirm: boolean) {
    this.assertSuperAdmin(actor);
    const affiliateAccountId = requireNonBlank(input.affiliateAccountId, 'affiliateAccountId');
    const settlementMonth = parseMonthStart(input.settlementMonth, 'settlementMonth');
    await this.getCakeAccount(affiliateAccountId);
    const action = `cake_monthly_review.${confirm ? 'confirm' : 'cancel'}`;
    await this.monthLock.assertWritable({ settlementMonth, action, objectType: 'cake_monthly_income_reviews', requestPayload: { affiliateAccountId, settlementMonth } }, actor);
    return this.prisma.$transaction(async tx => {
      // Same key as native income writes and month locking: fingerprint reads,
      // confirmation and its audit are one coherent snapshot even during refresh.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`monthly-finance:${settlementMonth.toISOString()}`}, 0))`;
      const locked = await tx.monthlySettlement.findUnique({ where: { settlementMonth }, select: { status: true } });
      if (locked?.status === 'locked') throw new AppError(ERROR_CODES.MONTH_LOCKED, '当前结算月份已锁账，不能修改核对记录。');
      const where = { affiliateAccountId_settlementMonth: { affiliateAccountId, settlementMonth } };
      const before = await tx.cakeMonthlyIncomeReview.findUnique({ where });
      const review = await readCakeMonthlyReview(tx, affiliateAccountId, settlementMonth);
      if (confirm) {
        if (!input.baseFingerprint || input.baseFingerprint !== review.baseFingerprint) throw new AppError(ERROR_CODES.CONFLICT, 'CAKE API原生佣金已变化，请刷新后重新核对。');
        if (review.confirmedAdjustmentCount || review.staleAdjustmentCount) throw new AppError(ERROR_CODES.CONFLICT, '存在已确认或待复核调整，请先处理调整，不能确认无需调整。');
        await tx.cakeMonthlyIncomeReview.upsert({ where, create: { affiliateAccountId, settlementMonth, baseFingerprint: review.baseFingerprint, confirmedBy: actor.userId }, update: { baseFingerprint: review.baseFingerprint, confirmedBy: actor.userId, confirmedAt: new Date() } });
      } else {
        await tx.cakeMonthlyIncomeReview.deleteMany({ where: { affiliateAccountId, settlementMonth } });
      }
      const after = await tx.cakeMonthlyIncomeReview.findUnique({ where });
      await this.audit.success({ actorUserId: actor.userId, actorRole: actor.roleCode, action, objectType: 'cake_monthly_income_reviews', objectId: affiliateAccountId, settlementMonth, beforeData: before, afterData: after, changedFields: ['baseFingerprint', 'confirmedBy', 'confirmedAt'], requestPayload: { affiliateAccountId, settlementMonth }, ipAddress: actor.ipAddress, userAgent: actor.userAgent }, tx);
      return { review: await readCakeMonthlyReview(tx, affiliateAccountId, settlementMonth) };
    }).catch(async error => {
      // A lock may commit after the initial check; persist its denial outside the
      // rolled-back transaction, just as MonthLockService does for an existing lock.
      if (error instanceof AppError && error.code === ERROR_CODES.MONTH_LOCKED) {
        await this.audit.failure({ actorUserId: actor.userId, actorRole: actor.roleCode, action, objectType: 'cake_monthly_income_reviews', objectId: affiliateAccountId, settlementMonth, requestPayload: { affiliateAccountId, settlementMonth }, failureReason: ERROR_CODES.MONTH_LOCKED, errorMessage: '结算月份在核对提交前已锁账。', ipAddress: actor.ipAddress, userAgent: actor.userAgent });
      }
      throw error;
    });
  }

  async saveDraft(input: SaveCakeIncomeAdjustmentInput, actor: Actor) {
    this.assertSuperAdmin(actor);
    const resolved = await this.resolveInput(input);
    await this.monthLock.assertWritable({
      settlementMonth: resolved.settlementMonth,
      action: 'cake_income_adjustment.save_draft',
      objectType: 'income_records',
      requestPayload: safeRequest(input),
    }, actor);
    const externalRecordId = cakeAdjustmentExternalRecordId(resolved.affiliateAccountId, resolved.settlementMonth, resolved.subValue);
    const existing = await this.prisma.incomeRecord.findUnique({
      where: { source_externalRecordId: { source: CAKE_ADJUSTMENT_SOURCE, externalRecordId } },
    });
    if (existing?.status === CommonStatus.confirmed) {
      throw new AppError(ERROR_CODES.CONFLICT, '已确认的调整不能直接编辑；请先停用后再保存新的草稿值。');
    }
    if (resolved.adjustmentUsd.isZero()) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'CST实际Revenue与API基准相同，无需创建调整。');
    }
    const metadata = buildCakeAdjustmentMetadata(resolved);
    const data = {
      settlementMonth: resolved.settlementMonth,
      affiliateAccountId: resolved.affiliateAccountId,
      employeeId: resolved.employeeId,
      source: CAKE_ADJUSTMENT_SOURCE,
      externalRecordId,
      subField: CAKE_SUB_FIELD,
      subValue: resolved.subValue,
      incomeUsd: resolved.adjustmentUsd,
      rawData: metadata as unknown as Prisma.InputJsonObject,
      status: CommonStatus.draft,
      importedBy: actor.userId,
    };
    const after = await this.prisma.incomeRecord.upsert({
      where: { source_externalRecordId: { source: CAKE_ADJUSTMENT_SOURCE, externalRecordId } },
      create: data,
      update: data,
    });
    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'cake_income_adjustment.save_draft',
      objectType: 'income_records',
      objectId: after.id,
      settlementMonth: resolved.settlementMonth,
      beforeData: existing,
      afterData: after,
      changedFields: ['employeeId', 'incomeUsd', 'rawData', 'status'],
      requestPayload: safeRequest(input),
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return after;
  }

  async confirm(id: string, actor: Actor) {
    this.assertSuperAdmin(actor);
    const before = await this.getAdjustment(id);
    await this.monthLock.assertWritable({
      settlementMonth: before.settlementMonth,
      action: 'cake_income_adjustment.confirm',
      objectType: 'income_records',
      objectId: id,
      requestPayload: { id },
    }, actor);
    if (before.status !== CommonStatus.draft) {
      throw new AppError(ERROR_CODES.CONFLICT, '只有草稿状态的CAKE收入调整可以确认。');
    }
    const metadata = readCakeAdjustmentMetadata(before.rawData);
    if (!metadata || !before.affiliateAccountId || !before.subValue) {
      throw new AppError(ERROR_CODES.CONFLICT, '调整记录缺少可验证的基准数据。');
    }
    const resolved = await this.resolveInput({
      affiliateAccountId: before.affiliateAccountId,
      settlementMonth: before.settlementMonth,
      subValue: before.subValue,
      actualRevenueUsd: metadata.targetRevenueUsd,
      reason: metadata.reason,
    });
    if (resolved.adjustmentUsd.isZero()) {
      throw new AppError(ERROR_CODES.CONFLICT, '当前API基准已等于CST实际Revenue，无需确认调整。');
    }
    const after = await this.prisma.incomeRecord.update({
      where: { id },
      data: {
        employeeId: resolved.employeeId,
        incomeUsd: resolved.adjustmentUsd,
        rawData: buildCakeAdjustmentMetadata(resolved) as unknown as Prisma.InputJsonObject,
        status: CommonStatus.confirmed,
        importedBy: actor.userId,
      },
    });
    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'cake_income_adjustment.confirm',
      objectType: 'income_records',
      objectId: id,
      settlementMonth: before.settlementMonth,
      beforeData: before,
      afterData: after,
      changedFields: ['employeeId', 'incomeUsd', 'rawData', 'status'],
      requestPayload: { id },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return after;
  }

  async disable(id: string, actor: Actor) {
    this.assertSuperAdmin(actor);
    const before = await this.getAdjustment(id);
    await this.monthLock.assertWritable({
      settlementMonth: before.settlementMonth,
      action: 'cake_income_adjustment.disable',
      objectType: 'income_records',
      objectId: id,
      requestPayload: { id },
    }, actor);
    if (before.status === CommonStatus.disabled) return before;
    const after = await this.prisma.incomeRecord.update({ where: { id }, data: { status: CommonStatus.disabled } });
    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'cake_income_adjustment.disable',
      objectType: 'income_records',
      objectId: id,
      settlementMonth: before.settlementMonth,
      beforeData: before,
      afterData: after,
      changedFields: ['status'],
      requestPayload: { id },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return after;
  }

  async exportCsv(query: CakeIncomeAdjustmentQuery, actor: Actor) {
    const payload = await this.list(query, actor);
    const headers = [
      'Platform', 'Affiliate Account', 'Affiliate ID', 'Settlement Month', 'SUB Field', 'SUB Value',
      'API Default Timezone Revenue USD', 'China Standard Time Actual Revenue USD',
      'Proposed Adjustment USD', 'Confirmed Adjustment USD',
      'Preview Final Revenue USD', 'Settlement Final Revenue USD', 'Employee Code',
      'Employee Name', 'Status', 'Reason', 'Updated At',
    ];
    const rows = payload.items.map((item) => [
      'cake', payload.account.accountName ?? '', payload.account.accountCode, payload.settlementMonth,
      item.subField, item.subValue, item.baseRevenueUsd, item.actualRevenueUsd ?? item.baseRevenueUsd,
      item.adjustmentUsd, item.confirmedAdjustmentUsd,
      item.previewRevenueUsd, item.finalRevenueUsd,
      item.employeeCode ?? '', item.employeeName ?? '', item.status ?? 'none', item.reason ?? '', item.updatedAt?.toISOString() ?? '',
    ]);
    const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
    return { filename: `cake-sub-revenue-adjustments-${payload.account.accountCode}-${payload.settlementMonth}.csv`, csv };
  }

  private async resolveInput(input: SaveCakeIncomeAdjustmentInput, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const affiliateAccountId = requireNonBlank(input.affiliateAccountId, 'affiliateAccountId');
    const settlementMonth = parseMonthStart(input.settlementMonth, 'settlementMonth');
    const subValue = requireNonBlank(input.subValue, 'subValue');
    const actualRevenueUsd = parseDecimalString(input.actualRevenueUsd, 'actualRevenueUsd');
    const reason = requireNonBlank(input.reason, 'reason');
    if (reason.length > MAX_REASON_LENGTH) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `reason must be at most ${MAX_REASON_LENGTH} characters.`);
    await this.getCakeAccount(affiliateAccountId, db);
    const [mappings, baseRows] = await Promise.all([
      resolveEffectiveSubIdMappings(db as unknown as EffectiveSubIdMappingReader, {
        affiliateAccountId,
        settlementMonth,
        subField: CAKE_SUB_FIELD,
        subValue,
      }),
      db.incomeRecord.findMany({
        where: { affiliateAccountId, settlementMonth, source: CAKE_BASE_SOURCE, status: CommonStatus.confirmed, subField: CAKE_SUB_FIELD, subValue },
        select: { employeeId: true, incomeUsd: true },
      }),
    ]);
    const activeMappings = mappings.filter(isActiveEffectiveSubIdMapping);
    const employeeIds = [...new Set(activeMappings.map((mapping) => mapping.employeeId))];
    if (baseRows.length === 0) {
      throw new AppError(ERROR_CODES.CONFLICT, '该SUB没有已确认的CAKE API基础收入记录，不能创建收入调整。');
    }
    if (mappings.length === 0 || activeMappings.length !== mappings.length || employeeIds.length === 0) {
      throw new AppError(ERROR_CODES.CONFLICT, '该SUB没有有效员工映射，不能创建收入调整。');
    }
    if (employeeIds.length > 1) throw new AppError(ERROR_CODES.CONFLICT, '该SUB映射到多个员工，不能创建收入调整。');
    if (activeMappings.some((mapping) => mapping.employee.status !== CommonStatus.active)) {
      throw new AppError(ERROR_CODES.CONFLICT, '该SUB映射的员工不是启用状态。');
    }
    const employeeId = employeeIds[0];
    if (baseRows.some((row) => row.employeeId && row.employeeId !== employeeId)) {
      throw new AppError(ERROR_CODES.CONFLICT, 'API收入记录与当前SUB员工映射不一致。');
    }
    const baseRevenueUsd = sum(baseRows.map((row) => row.incomeUsd));
    const adjustmentUsd = actualRevenueUsd.minus(baseRevenueUsd);
    if (baseRevenueUsd.plus(adjustmentUsd).isNegative()) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, '调整后的最终Revenue不能小于0。');
    }
    return { affiliateAccountId, settlementMonth, subValue, employeeId, baseRevenueUsd, actualRevenueUsd, adjustmentUsd, reason };
  }

  private async getCakeAccount(id: string, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const account = await db.affiliateAccount.findUnique({
      where: { id },
      select: { id: true, platform: true, accountCode: true, accountName: true },
    });
    if (!account) throw new AppError(ERROR_CODES.NOT_FOUND, '联盟账号不存在。');
    if (account.platform !== 'cake') throw new AppError(ERROR_CODES.VALIDATION_ERROR, '收入调整只支持CAKE联盟账号。');
    return account;
  }

  private async getAdjustment(id: string) {
    const record = await this.prisma.incomeRecord.findUnique({ where: { id } });
    if (!record || record.source !== CAKE_ADJUSTMENT_SOURCE) throw new AppError(ERROR_CODES.NOT_FOUND, 'CAKE收入调整不存在。');
    return record;
  }

  private assertSuperAdmin(actor: Actor) {
    if (actor.roleCode !== 'super_admin' || !actor.permissions.includes('income.import')) {
      throw new AppError(ERROR_CODES.FORBIDDEN, '只有拥有收入导入权限的super_admin可以管理CAKE收入调整。');
    }
  }
}

function safeRequest(input: SaveCakeIncomeAdjustmentInput) {
  return {
    affiliateAccountId: input.affiliateAccountId,
    settlementMonth: input.settlementMonth,
    subValue: input.subValue,
    actualRevenueUsd: input.actualRevenueUsd,
    reason: input.reason,
  };
}

function sum(values: Prisma.Decimal[]) {
  return values.reduce((total, value) => total.plus(value), new Prisma.Decimal(0));
}

function formatMonth(date: Date) {
  return date.toISOString().slice(0, 7);
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
