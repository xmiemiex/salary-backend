import { CommonStatus, Prisma } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AffiliateAccountsService } from './affiliate-accounts.service';

const actor = {
  userId: '00000000-0000-0000-0000-000000000001',
  roleCode: 'admin',
  permissions: ['api_config.manage'],
};

describe('AffiliateAccountsService', () => {
  let prisma: {
    affiliateAccount: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };
  let audit: { success: jest.Mock; failure: jest.Mock };
  let service: AffiliateAccountsService;

  beforeEach(() => {
    prisma = {
      affiliateAccount: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    audit = { success: jest.fn(), failure: jest.fn() };
    service = new AffiliateAccountsService(prisma as never, audit as never);
  });

  it.each(['cake', 'everflow'])('allows exact platform %s and keeps accountCode as a string', async (platform) => {
    prisma.affiliateAccount.create.mockImplementation(async ({ data }) => ({ id: 'account-1', ...data }));

    await service.create({ platform, accountCode: '329', accountName: '', status: CommonStatus.active }, actor);

    expect(prisma.affiliateAccount.create).toHaveBeenCalledWith({
      data: {
        platform,
        accountCode: '329',
        accountName: undefined,
        status: CommonStatus.active,
      },
    });
  });

  it.each(['Blitzads', 'Cake Ads', ' cake', 'cake ', 'CAKE', '', ' '])(
    'rejects non-whitelisted platform value %p',
    async (platform) => {
      await expect(service.create({ platform, accountCode: '329' }, actor)).rejects.toMatchObject({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'platform must be exactly cake or everflow.',
      });
      expect(prisma.affiliateAccount.create).not.toHaveBeenCalled();
    },
  );

  it('does not write or clear the legacy defaultEmployeeId on create or update', async () => {
    prisma.affiliateAccount.create.mockImplementation(async ({ data }) => ({ id: 'account-1', ...data }));
    prisma.affiliateAccount.findUnique.mockResolvedValue({
      id: 'account-1',
      platform: 'cake',
      accountCode: '329',
      accountName: 'Old',
      defaultEmployeeId: 'legacy-employee',
      status: CommonStatus.active,
    });
    prisma.affiliateAccount.update.mockImplementation(async ({ data }) => ({
      id: 'account-1',
      platform: 'cake',
      accountCode: '329',
      defaultEmployeeId: 'legacy-employee',
      ...data,
    }));

    await service.create(
      { platform: 'cake', accountCode: '329', defaultEmployeeId: 'ignored' } as never,
      actor,
    );
    await service.update(
      'account-1',
      { accountName: 'Blitzads', defaultEmployeeId: 'ignored' } as never,
      actor,
    );

    expect(prisma.affiliateAccount.create.mock.calls[0][0].data).not.toHaveProperty('defaultEmployeeId');
    expect(prisma.affiliateAccount.update.mock.calls[0][0].data).not.toHaveProperty('defaultEmployeeId');
  });

  it('returns duplicate resource for the existing platform + accountCode database constraint', async () => {
    prisma.affiliateAccount.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' }),
    );

    await expect(service.create({ platform: 'cake', accountCode: '329' }, actor)).rejects.toMatchObject({
      code: ERROR_CODES.DUPLICATE_RESOURCE,
    });
  });
});
