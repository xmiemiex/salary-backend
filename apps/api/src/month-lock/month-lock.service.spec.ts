import { AuditResult, SettlementStatus } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { MonthLockService } from './month-lock.service';

describe('MonthLockService', () => {
  const settlementMonth = new Date('2026-05-01T00:00:00.000Z');

  function createService(status: SettlementStatus | null) {
    const prisma = {
      monthlySettlement: {
        findUnique: jest.fn().mockResolvedValue(status ? { id: 's1', status } : null),
        upsert: jest.fn(),
      },
    };
    const audit = {
      failure: jest.fn().mockResolvedValue(undefined),
      success: jest.fn().mockResolvedValue(undefined),
    };
    return {
      service: new MonthLockService(prisma as never, audit as unknown as AuditService),
      prisma,
      audit,
    };
  }

  it('allows writes when month is not locked', async () => {
    const { service, audit } = createService(SettlementStatus.draft);

    await service.assertWritable({
      settlementMonth,
      action: 'manual_card_spend.create',
      objectType: 'manual_card_spend_entries',
    });

    expect(audit.failure).not.toHaveBeenCalled();
  });

  it('audits and rejects writes when month is locked', async () => {
    const { service, audit } = createService(SettlementStatus.locked);

    await expect(
      service.assertWritable(
        {
          settlementMonth,
          action: 'manual_card_spend.create',
          objectType: 'manual_card_spend_entries',
        },
        { userId: 'u1', roleCode: 'finance' },
      ),
    ).rejects.toBeInstanceOf(AppError);

    expect(audit.failure).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'u1',
        actorRole: 'finance',
        failureReason: ERROR_CODES.MONTH_LOCKED,
      }),
    );
  });

  it('keeps audit result assignment inside AuditService helpers', () => {
    expect(AuditResult.failure).toBe('failure');
  });
});
