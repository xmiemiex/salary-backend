import { Injectable } from '@nestjs/common';
import { CommonStatus, Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../auth/auth.types';
import { parseDecimalString, parseMonthStart, requireNonBlank } from '../base-data/base-data.utils';
import { AppError } from '../common/app-error';
import { MonthLockService } from '../month-lock/month-lock.service';
import { PrismaService } from '../prisma/prisma.service';
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

  private async resolveInput(input: SaveCakeIncomeAdjustmentInput) {
    const affiliateAccountId = requireNonBlank(input.affiliateAccountId, 'affiliateAccountId');
    const settlementMonth = parseMonthStart(input.settlementMonth, 'settlementMonth');
    const subValue = requireNonBlank(input.subValue, 'subValue');
    const actualRevenueUsd = parseDecimalString(input.actualRevenueUsd, 'actualRevenueUsd');
    const reason = requireNonBlank(input.reason, 'reason');
    if (reason.length > MAX_REASON_LENGTH) throw new AppError(ERROR_CODES.VALIDATION_ERROR, `reason must be at most ${MAX_REASON_LENGTH} characters.`);
    await this.getCakeAccount(affiliateAccountId);
    const [mappings, baseRows] = await Promise.all([
      resolveEffectiveSubIdMappings(this.prisma as unknown as EffectiveSubIdMappingReader, {
        affiliateAccountId,
        settlementMonth,
        subField: CAKE_SUB_FIELD,
        subValue,
      }),
      this.prisma.incomeRecord.findMany({
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

  private async getCakeAccount(id: string) {
    const account = await this.prisma.affiliateAccount.findUnique({
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
