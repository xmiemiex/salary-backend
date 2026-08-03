import { EverflowCalibrationService } from './everflow-calibration.service';
import { EVERFLOW_MONTHLY_SUB_CALIBRATION_ACTION } from './everflow-income-sync.adapter';

describe('EverflowCalibrationService', () => {
  it('records a pass only when SUB1 and offer totals agree in a metadata-confirmed GMT+8 timezone', async () => {
    const prisma: any = {
      affiliateAccount: { findUnique: jest.fn().mockResolvedValue({ id: 'account-1', platform: 'everflow', accountCode: '21490', accountName: 'DFO' }) },
      subIdMapping: { findMany: jest.fn().mockResolvedValue([{ subField: 'sub1', subValue: 'ZW', employeeId: 'emp-1' }]) },
    };
    const credentials: any = { getAffiliateAccountCredentialPayload: jest.fn().mockResolvedValue({ payload: { apiKey: 'secret' } }) };
    const client: any = {
      getTimezones: jest.fn().mockResolvedValue({ timezones: [{ timezone_id: 20, timezone_name: 'China Standard Time', timezone: 'Asia/Shanghai', utc_offset: '+08:00' }], httpStatus: 200 }),
      getAffiliateSubRevenueSummary: jest.fn().mockResolvedValue({
        table: [{ columns: [{ column_type: 'sub1', id: 'ZW' }], reporting: { revenue: 100 } }], incomplete_results: false, httpStatus: 200,
      }),
      getAffiliateOfferRevenueSummary: jest.fn().mockResolvedValue({
        table: [{ columns: [{ column_type: 'offer', id: '1' }], reporting: { revenue: 100 } }], incomplete_results: false, httpStatus: 200,
      }),
    };
    const audit: any = { success: jest.fn().mockResolvedValue({}) };
    const service = new EverflowCalibrationService(prisma, credentials, client, audit);
    const result = await service.run('account-1', { settlementMonth: '2026-07' }, { userId: 'user-1', roleCode: 'admin' } as any);
    expect(result).toMatchObject({ writeGateEligible: true, rawPayloadReturned: false, returnedCount: 1 });
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: EVERFLOW_MONTHLY_SUB_CALIBRATION_ACTION }));
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('does not pass when the independent offer total differs', async () => {
    const prisma: any = {
      affiliateAccount: { findUnique: jest.fn().mockResolvedValue({ id: 'account-1', platform: 'everflow', accountCode: '21490', accountName: 'DFO' }) },
      subIdMapping: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const credentials: any = { getAffiliateAccountCredentialPayload: jest.fn().mockResolvedValue({ payload: { apiKey: 'secret' } }) };
    const client: any = {
      getTimezones: jest.fn().mockResolvedValue({ timezones: [{ timezone_id: 75, timezone_name: 'China Standard Time', utc_offset: 'UTC+08:00' }] }),
      getAffiliateSubRevenueSummary: jest.fn().mockResolvedValue({ table: [{ columns: [{ id: 'ZW' }], reporting: { revenue: 100 } }] }),
      getAffiliateOfferRevenueSummary: jest.fn().mockResolvedValue({ table: [{ columns: [{ id: '1' }], reporting: { revenue: 99 } }] }),
    };
    const audit: any = { success: jest.fn().mockResolvedValue({}) };
    const result = await new EverflowCalibrationService(prisma, credentials, client, audit).run(
      'account-1', { settlementMonth: '2026-07' }, { userId: 'user-1', roleCode: 'admin' } as any,
    );
    expect(result.writeGateEligible).toBe(false);
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: 'everflow.monthly_sub_revenue.calibration.read' }));
  });
});
