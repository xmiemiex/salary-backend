import { CakeCalibrationService } from './cake-calibration.service';
import { CAKE_MONTHLY_SUB_CALIBRATION_ACTION } from './cake-income-sync.adapter';

describe('CakeCalibrationService', () => {
  const actor = { userId: 'user-1', roleCode: 'admin', ipAddress: null, userAgent: null } as any;
  let prisma: any;
  let credentials: any;
  let client: any;
  let audit: any;
  let service: CakeCalibrationService;

  beforeEach(() => {
    prisma = {
      affiliateAccount: { findUnique: jest.fn().mockResolvedValue({ id: 'account-1', platform: 'cake', accountCode: '329', accountName: 'Blitzads' }) },
      subIdMapping: { findMany: jest.fn().mockResolvedValue([{ subField: 'sub1', subValue: 'ZW', employeeId: 'emp-1' }]) },
    };
    credentials = { getAffiliateAccountCredentialPayload: jest.fn().mockResolvedValue({ payload: { apiKey: 'secret', baseUrl: 'https://cake.test/affiliates/api' } }) };
    client = {
      getSubAffiliateSummary: jest.fn().mockResolvedValue({ rows: [{ sub_id: 'ZW', revenue: '100' }], rowCount: 1, httpStatus: 200 }),
      getCampaignSummary: jest.fn().mockResolvedValue({ rows: [{ revenue: '100', currency_id: 1, currency_symbol: '$' }], rowCount: 1, httpStatus: 200 }),
      getCurrencies: jest.fn().mockResolvedValue({ rows: [{ currency_id: 1, currency_name: 'USD' }], rowCount: 1, httpStatus: 200 }),
    };
    audit = { success: jest.fn().mockResolvedValue({}) };
    service = new CakeCalibrationService(prisma, credentials, client, audit);
  });

  it('calibrates the complete month read-only and opens the write gate only with matching USD totals', async () => {
    const result = await service.run('account-1', { settlementMonth: '2026-07' }, actor);
    expect(result).toMatchObject({ readOnly: true, rawPayloadReturned: false, writeGateEligible: true, affiliateId: '329' });
    expect(client.getSubAffiliateSummary).toHaveBeenCalledWith(expect.objectContaining({ affiliateId: '329', startDate: '2026-07-01T00:00:00', endDate: '2026-08-01T00:00:00' }));
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: CAKE_MONTHLY_SUB_CALIBRATION_ACTION }));
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('keeps the write gate closed when report totals do not match', async () => {
    client.getCampaignSummary.mockResolvedValue({ rows: [{ revenue: '99', currency_id: 1 }], rowCount: 1, httpStatus: 200 });
    const result = await service.run('account-1', { startDate: '2026-07-01', endDate: '2026-07-31' }, actor);
    expect(result.writeGateEligible).toBe(false);
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: 'cake.monthly_sub_revenue.calibration.read' }));
  });
});
