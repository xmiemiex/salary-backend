import { CommonStatus, Provider, SyncTaskSourceType } from '@prisma/client';
import { SyncPlanningService } from './sync-planning.service';

describe('SyncPlanningService preview', () => {
  function setup(options: { locked?: boolean; credential?: boolean; existing?: boolean; platform?: string } = {}) {
    const writes = { task: 0, audit: 0 };
    const prisma = {
      monthlySettlement: { findUnique: jest.fn().mockResolvedValue(options.locked ? { status: 'locked' } : null) },
      affiliateAccount: { findMany: jest.fn().mockResolvedValue([
        { id: 'account-1', platform: options.platform ?? 'everflow', accountCode: 'Blitz', accountName: 'Blitz', status: CommonStatus.active, credential: options.credential === false ? null : { id: 'credential-1', status: CommonStatus.active } },
      ]) },
      cardProviderCredential: { findMany: jest.fn().mockResolvedValue(options.credential === false ? [] : [
        { id: 'air-credential', provider: Provider.airwallex, status: CommonStatus.active },
        { id: 'photon-credential', provider: Provider.photonpay, status: CommonStatus.active },
      ]) },
      syncTask: {
        findMany: jest.fn().mockResolvedValue(options.existing ? [{ id: 'existing-1', sourceType: SyncTaskSourceType.affiliate_income, affiliateAccountId: 'account-1', provider: null, status: 'failed' }] : []),
        create: jest.fn(() => { writes.task++; }),
      },
    };
    const audit = { success: jest.fn(() => { writes.audit++; }) };
    return { service: new SyncPlanningService(prisma as never, audit as never), prisma, writes };
  }

  it('builds Everflow/Blitz plus Airwallex and PhotonPay without treating Blitz as a platform', async () => {
    const { service } = setup();
    const result = await service.preview('2026-06');
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]).toMatchObject({ affiliateAccountName: 'Blitz', platform: 'everflow', canCreate: true });
    expect(result.candidates.slice(1).map((item) => item.provider)).toEqual(['airwallex', 'photonpay']);
    expect(JSON.stringify(result)).not.toMatch(/credentialId|planningKey|encryptedPayload|maskedPayload/i);
  });
  it('is read-only and reports missing credentials', async () => {
    const { service, prisma, writes } = setup({ credential: false });
    const result = await service.preview('2026-06');
    expect(result.candidates.every((item) => item.blockerCodes.includes('CREDENTIAL_MISSING'))).toBe(true);
    expect(prisma.syncTask.create).not.toHaveBeenCalled();
    expect(writes).toEqual({ task: 0, audit: 0 });
  });
  it('blocks every candidate for a locked month', async () => {
    const result = await setup({ locked: true }).service.preview('2026-06');
    expect(result.locked).toBe(true);
    expect(result.candidates.every((item) => !item.canCreate && item.blockerCodes.includes('MONTH_LOCKED'))).toBe(true);
  });
  it('recognizes failed tasks as existing and rejects unsupported account platforms', async () => {
    const existing = await setup({ existing: true }).service.preview('2026-06');
    expect(existing.candidates[0]).toMatchObject({ existingTaskId: 'existing-1', canCreate: false });
    const unsupported = await setup({ platform: 'blitz' }).service.preview('2026-06');
    expect(unsupported.candidates[0].blockerCodes).toContain('UNSUPPORTED_PLATFORM');
  });
});
