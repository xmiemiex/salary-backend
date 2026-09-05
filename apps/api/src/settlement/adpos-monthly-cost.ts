import { Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';

export async function applyAdposMonthlyCost<T extends { providerName?: string; settledSpendUsd?: Prisma.Decimal; actualSpendUsd: Prisma.Decimal }>(db: PrismaService, month: Date, entries: T[]): Promise<T[]> {
  if (!entries.some(e => e.providerName?.trim().toLowerCase() === 'adpos' && !e.settledSpendUsd?.isZero())) return entries;
  const rate = await db.monthlyAdposFeeRate.findUnique({ where: { settlementMonth: month } });
  if (!rate) throw new AppError(ERROR_CODES.SETTLEMENT_PRECHECK_FAILED, 'Adpos 本月手续费待填写，不能生成最终工资。');
  return entries.map(e => e.providerName?.trim().toLowerCase() === 'adpos' ? { ...e, actualSpendUsd: e.settledSpendUsd!.times(new Prisma.Decimal(1).plus(rate.feeRate)) } : e);
}
