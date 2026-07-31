import { ERROR_CODES } from '@salary/shared';
import { CakeCalibrationService } from './cake-calibration.service';

const actor = {
  userId: '00000000-0000-0000-0000-000000000001',
  roleCode: 'admin',
  permissions: ['income.import'],
};

describe('CakeCalibrationService', () => {
  let prisma: {
    affiliateAccount: { findUnique: jest.Mock };
    subIdMapping: { findMany: jest.Mock };
  };
  let credentials: { getAffiliateAccountCredentialPayload: jest.Mock };
  let client: {
    getConversions: jest.Mock;
    getDispositionTypes: jest.Mock;
    getCampaignSummary: jest.Mock;
    getCurrencies: jest.Mock;
  };
  let audit: { success: jest.Mock };
  let service: CakeCalibrationService;

  beforeEach(() => {
    prisma = {
      affiliateAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'account-1',
          platform: 'cake',
          accountCode: '329',
          accountName: 'Blitzads',
        }),
      },
      subIdMapping: {
        findMany: jest.fn().mockResolvedValue([
          {
            subField: 'sub1',
            subValue: 'employee-sub',
            employeeId: 'employee-1',
            employee: { employeeCode: '01', name: 'Alice' },
          },
        ]),
      },
    };
    credentials = {
      getAffiliateAccountCredentialPayload: jest.fn().mockResolvedValue({
        credentialId: 'credential-1',
        payload: {
          apiKey: 'test-only-secret',
          baseUrl: 'https://cake.example.test/affiliates/api',
        },
        maskedPayload: { apiKey: 'test****cret' },
      }),
    };
    client = {
      getConversions: jest.fn(),
      getDispositionTypes: jest.fn().mockResolvedValue({
        rows: [
          { disposition_type_id: 1, disposition_type_name: 'Approved' },
          { disposition_type_id: 2, disposition_type_name: 'Pending' },
        ],
        rowCount: 2,
        httpStatus: 200,
      }),
      getCampaignSummary: jest.fn().mockResolvedValue({
        rows: [{ revenue: '1246.34', currency_id: 1, currency_symbol: '$' }],
        rowCount: 1,
        httpStatus: 200,
      }),
      getCurrencies: jest.fn().mockResolvedValue({
        rows: [{ currency_id: 1, currency_name: 'US Dollar' }],
        rowCount: 1,
        httpStatus: 200,
      }),
    };
    audit = { success: jest.fn().mockResolvedValue(undefined) };
    service = new CakeCalibrationService(
      prisma as never,
      credentials as never,
      client as never,
      audit as never,
    );
  });

  it('uses accountCode, inspects at most two read-only pages, and returns only a safe summary', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      conversion_id: `conversion-${index}`,
      conversion_date: '2026-07-30T12:00:00+08:00',
      subid_1: index === 0 ? 'employee-sub' : index === 1 ? 'unmapped-sensitive-value' : '',
      price: '12.34',
      disposition: index === 0 ? 'Approved' : 'Pending',
      api_key: 'must-not-return',
    }));
    client.getConversions
      .mockResolvedValueOnce({ conversions: firstPage, rowCount: 101, httpStatus: 200, raw: { secret: true } })
      .mockResolvedValueOnce({
        conversions: [{ ...firstPage[0] }],
        rowCount: 101,
        httpStatus: 200,
        raw: { secret: true },
      })
      .mockResolvedValueOnce({ conversions: firstPage, rowCount: 100, httpStatus: 200, raw: {} })
      .mockResolvedValueOnce({
        conversions: [{ ...firstPage[0], conversion_id: 'end-day-1', conversion_date: '2026-07-31T12:00:00+08:00' }],
        rowCount: 1,
        httpStatus: 200,
        raw: {},
      });

    const result = await service.run(
      'account-1',
      { startDate: '2026-07-30', endDate: '2026-07-31' },
      actor,
    );

    expect(client.getConversions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ affiliateId: '329', startAtRow: 1, rowLimit: 100 }),
    );
    expect(client.getConversions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ affiliateId: '329', startAtRow: 101, rowLimit: 100 }),
    );
    expect(result).toMatchObject({
      affiliateId: '329',
      affiliateIdSource: 'affiliate_accounts.account_code',
      returnedCount: 101,
      providerRowCount: 101,
      duplicateExternalIdCount: 1,
      httpResult: { success: true, statuses: [200] },
      pagination: { pageCount: 2, pageReturnedCounts: [100, 1], moreRowsPossible: false },
      dateBoundaryEvidence: { endDateInclusivity: 'unconfirmed_requires_more_evidence' },
      dispositionTypeEvidence: { returnedCount: 2, payablePolicyConfirmed: false },
      payoutEvidence: { sameWindowTotalsEqual: true, conversionsComplete: true, campaignSummaryComplete: true },
      currencyEvidence: { campaignCurrencyNames: ['US Dollar'], usdConfirmed: true },
      subAttributionEvidence: {
        readOnly: true,
        evaluationSupported: true,
        effectiveMonth: '2026-07-01',
        configuredMappingCount: 1,
        recordsWithSubCount: 3,
        attributedRecordCount: 2,
        noSubRecordCount: 98,
        unmappedRecordCount: 1,
        conflictingEmployeeRecordCount: 0,
        mappingMatchCounts: [
          {
            subField: 'sub1',
            subValue: 'employee-sub',
            employeeCode: '01',
            employeeName: 'Alice',
            recordCount: 2,
          },
        ],
      },
      rawPayloadReturned: false,
    });
    expect(prisma.subIdMapping.findMany).toHaveBeenCalledWith({
      where: {
        affiliateAccountId: 'account-1',
        effectiveMonth: new Date('2026-07-01T00:00:00.000Z'),
        status: 'active',
      },
      select: {
        subField: true,
        subValue: true,
        employeeId: true,
        employee: { select: { employeeCode: true, name: true } },
      },
    });
    const serialized = JSON.stringify({ result, audit: audit.success.mock.calls });
    expect(serialized).not.toContain('test-only-secret');
    expect(serialized).not.toContain('must-not-return');
    expect(serialized).not.toContain('unmapped-sensitive-value');
    expect(serialized).not.toContain('"raw"');
  });

  it('reports an observed exclusive end date for the live-style half-open sample', async () => {
    client.getConversions
      .mockResolvedValueOnce({
        conversions: [{ conversion_id: 'conversion-1', conversion_date: '2026-07-30T12:00:00', price: '5' }],
        rowCount: 1,
        httpStatus: 200,
        raw: {},
      })
      .mockResolvedValueOnce({ conversions: [], rowCount: 0, httpStatus: 200, raw: {} })
      .mockResolvedValueOnce({ conversions: [], rowCount: 0, httpStatus: 200, raw: {} });
    client.getCampaignSummary.mockResolvedValueOnce({
      rows: [{ revenue: '5', currency_id: 1, currency_symbol: '$' }],
      rowCount: 1,
      httpStatus: 200,
    });

    const result = await service.run(
      'account-1',
      { startDate: '2026-07-30', endDate: '2026-07-31' },
      actor,
    );

    expect(result.dateBoundaryEvidence).toMatchObject({
      startDayReturnedCount: 0,
      endDayReturnedCount: 0,
      endDateInclusivity: 'observed_exclusive_for_sample',
    });
  });

  it('rejects non-CAKE accounts and calibration ranges over two calendar days', async () => {
    prisma.affiliateAccount.findUnique.mockResolvedValueOnce({
      id: 'account-1',
      platform: 'everflow',
      accountCode: 'everflow-1',
      accountName: null,
    });
    await expect(
      service.run('account-1', { startDate: '2026-07-30', endDate: '2026-07-30' }, actor),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });

    prisma.affiliateAccount.findUnique.mockResolvedValueOnce({
      id: 'account-1',
      platform: 'cake',
      accountCode: '329',
      accountName: 'Blitzads',
    });
    await expect(
      service.run('account-1', { startDate: '2026-07-29', endDate: '2026-07-31' }, actor),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR });
    expect(client.getConversions).not.toHaveBeenCalled();
  });
});
