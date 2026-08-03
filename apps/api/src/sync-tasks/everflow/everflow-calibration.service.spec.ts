import { EverflowCalibrationService } from './everflow-calibration.service';
import { EVERFLOW_MONTHLY_SUB_CALIBRATION_ACTION } from './everflow-income-sync.adapter';

describe('EverflowCalibrationService', () => {
  it('records a pass only when aggregate rows equal the provider summary', async () => {
    const prisma: any = {
      affiliateAccount: { findUnique: jest.fn().mockResolvedValue({ id: 'account-1', platform: 'everflow', accountCode: '21490', accountName: 'DFO' }) },
      subIdMapping: { findMany: jest.fn().mockResolvedValue([{ subField: 'sub1', subValue: 'ZW', employeeId: 'emp-1' }]) },
    };
    const credentials: any = { getAffiliateAccountCredentialPayload: jest.fn().mockResolvedValue({ payload: { apiKey: 'secret' } }) };
    const client: any = { getAffiliateSubRevenueSummary: jest.fn().mockResolvedValue({
      table: [{ columns: [{ column_type: 'sub1', id: 'ZW' }], reporting: { revenue: 100 } }], summary: { revenue: 100 }, incomplete_results: false,
    }) };
    const audit: any = { success: jest.fn().mockResolvedValue({}) };
    const service = new EverflowCalibrationService(prisma, credentials, client, audit);
    const result = await service.run('account-1', { settlementMonth: '2026-07' }, { userId: 'user-1', roleCode: 'admin' } as any);
    expect(result).toMatchObject({ writeGateEligible: true, rawPayloadReturned: false, returnedCount: 1 });
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: EVERFLOW_MONTHLY_SUB_CALIBRATION_ACTION }));
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
