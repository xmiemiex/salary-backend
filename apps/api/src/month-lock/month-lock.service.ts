import { Injectable } from '@nestjs/common';
import { SettlementStatus } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { LockActor, MonthScopedWrite } from './month-lock.types';

@Injectable()
export class MonthLockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async isLocked(settlementMonth: Date): Promise<boolean> {
    const settlement = await this.prisma.monthlySettlement.findUnique({
      where: { settlementMonth },
      select: { status: true },
    });

    return settlement?.status === SettlementStatus.locked;
  }

  async assertWritable(write: MonthScopedWrite, actor?: LockActor): Promise<void> {
    if (!(await this.isLocked(write.settlementMonth))) {
      return;
    }

    await this.audit.failure({
      actorUserId: actor?.userId,
      actorRole: actor?.roleCode,
      action: write.action,
      objectType: write.objectType,
      objectId: write.objectId,
      settlementMonth: write.settlementMonth,
      requestPayload: write.requestPayload,
      failureReason: ERROR_CODES.MONTH_LOCKED,
      errorMessage: 'Settlement month is locked and cannot be modified.',
      ipAddress: actor?.ipAddress,
      userAgent: actor?.userAgent,
    });

    throw new AppError(ERROR_CODES.MONTH_LOCKED, '当前结算月份已锁账，禁止新增、修改或删除影响工资结果的数据。');
  }

  async lockMonth(settlementMonth: Date, actor: LockActor, lockReason: string) {
    const existing = await this.prisma.monthlySettlement.findUnique({
      where: { settlementMonth },
    });

    if (existing?.status === SettlementStatus.locked) {
      throw new AppError(ERROR_CODES.SETTLEMENT_ALREADY_LOCKED, '当前结算月份已经锁账。');
    }

    const settlement = await this.prisma.monthlySettlement.upsert({
      where: { settlementMonth },
      update: {
        status: SettlementStatus.locked,
        lockedAt: new Date(),
        lockedBy: actor.userId,
        lockReason,
      },
      create: {
        settlementMonth,
        status: SettlementStatus.locked,
        lockedAt: new Date(),
        lockedBy: actor.userId,
        lockReason,
      },
    });

    await this.audit.success({
      actorUserId: actor.userId,
      actorRole: actor.roleCode,
      action: 'settlement.lock',
      objectType: 'monthly_settlement',
      objectId: settlement.id,
      settlementMonth,
      beforeData: existing,
      afterData: settlement,
      changedFields: ['status', 'lockedAt', 'lockedBy', 'lockReason'],
      requestPayload: { settlementMonth, lockReason },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return settlement;
  }

  async unlockMonth() {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, '第一版默认不开放解锁。');
  }
}
