import { CommonStatus } from '@prisma/client';
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
      subIdMapping: { findMany: jest.fn().mockResolvedValue([
        mapping('ZW', 'emp-1'),
        mapping('YDF', 'emp-2'),
        mapping('MSY', 'emp-3'),
        mapping('DAN', 'emp-4'),
      ]) },
    };
    credentials = { getAffiliateAccountCredentialPayload: jest.fn().mockResolvedValue({ payload: { apiKey: 'secret', baseUrl: 'https://cake.test/affiliates/api' } }) };
    client = {
      getSubAffiliateSummary: jest.fn().mockResolvedValue({ rows: [
        { sub_id: 'ZW', revenue: '77710' }, { sub_id: 'YDF', revenue: '2600' },
        { sub_id: 'MSY', revenue: '585' }, { sub_id: 'DAN', revenue: '4420' },
        { sub_id: 'RRR', revenue: '0' }, { sub_id: 'PEI', revenue: '0' },
        { sub_id: 'JKY', revenue: '0' }, { sub_id: '', revenue: '195' },
      ], rowCount: 8, httpStatus: 200 }),
      getCampaignSummary: jest.fn().mockResolvedValue({ rows: [{ revenue: '85510', currency_id: 1, currency_symbol: '$' }], rowCount: 1, httpStatus: 200 }),
      getCurrencies: jest.fn().mockResolvedValue({ rows: [{ currency_id: 1, currency_name: 'USD' }], rowCount: 1, httpStatus: 200 }),
    };
    audit = { success: jest.fn().mockResolvedValue({}) };
    service = new CakeCalibrationService(prisma, credentials, client, audit);
  });

  it('calibrates the complete month read-only and opens the write gate only with matching USD totals', async () => {
    const result = await service.run('account-1', { settlementMonth: '2026-07' }, actor);
    expect(result).toMatchObject({ readOnly: true, rawPayloadReturned: false, writeGateEligible: true, affiliateId: '329' });
    expect(client.getSubAffiliateSummary).toHaveBeenCalledWith(expect.objectContaining({ affiliateId: '329', startDate: '2026-07-01T00:00:00', endDate: '2026-08-01T00:00:00' }));
    expect(prisma.subIdMapping.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      affiliateAccountId: 'account-1', effectiveMonth: { lte: new Date('2026-07-01T00:00:00.000Z') },
    }) }));
    expect(result.attribution).toMatchObject({ attributedPositiveCount: 4, unmatchedPositiveCount: 1, zeroRevenueCount: 3 });
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: CAKE_MONTHLY_SUB_CALIBRATION_ACTION }));
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('keeps the write gate closed when report totals do not match', async () => {
    client.getCampaignSummary.mockResolvedValue({ rows: [{ revenue: '99', currency_id: 1 }], rowCount: 1, httpStatus: 200 });
    const result = await service.run('account-1', { startDate: '2026-07-01', endDate: '2026-07-31' }, actor);
    expect(result.writeGateEligible).toBe(false);
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: 'cake.monthly_sub_revenue.calibration.read' }));
  });

  it('opens the default-timezone write gate when API reports agree while preserving the CST comparison as evidence', async () => {
    client.getSubAffiliateSummary.mockResolvedValue({
      rows: [{ sub_id: 'ZW', revenue: '77385' }, { sub_id: 'YDF', revenue: '3055' }, { sub_id: 'MSY', revenue: '585' }, { sub_id: 'DAN', revenue: '4485' }, { sub_id: '', revenue: '195' }],
      rowCount: 5,
      httpStatus: 200,
    });
    client.getCampaignSummary.mockResolvedValue({ rows: [{ revenue: '85705', currency_id: 1, currency_symbol: '$' }], rowCount: 1, httpStatus: 200 });
    const result = await service.run('account-1', { settlementMonth: '2026-07' }, actor);
    expect(result.writeGateEligible).toBe(true);
    expect(result.acceptanceBaseline).toMatchObject({ applicable: true, matches: false });
    expect(result.acceptanceBaseline.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ subValue: 'ZW', expectedRevenue: '77710', actualRevenue: '77385', delta: '-325' }),
      expect.objectContaining({ subValue: 'YDF', expectedRevenue: '2600', actualRevenue: '3055', delta: '455' }),
    ]));
    expect(result.timezone).toMatchObject({ providerTimezone: 'cake_system_default', verifiedAsChinaStandardTime: false, manualCstAdjustmentRequired: true });
    expect(audit.success).toHaveBeenCalledWith(expect.objectContaining({ action: CAKE_MONTHLY_SUB_CALIBRATION_ACTION }));
  });
});

function mapping(subValue: string, employeeId: string) {
  return {
    id: `mapping-${subValue}`, affiliateAccountId: 'account-1', subField: 'sub1', subValue,
    effectiveMonth: new Date('2026-06-01T00:00:00.000Z'), employeeId, status: CommonStatus.active,
    employee: { employeeCode: employeeId, name: employeeId, status: CommonStatus.active },
  };
}
