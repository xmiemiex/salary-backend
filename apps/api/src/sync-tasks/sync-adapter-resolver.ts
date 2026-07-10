import { Injectable } from '@nestjs/common';
import { Provider, SyncTaskPlatform, SyncTaskSourceType } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { AppError } from '../common/app-error';
import { SyncAdapter } from './sync-adapter';
import { AirwallexCardSyncAdapter } from './airwallex/airwallex-card-sync.adapter';
import { CakeIncomeSyncAdapter } from './cake/cake-income-sync.adapter';
import { EverflowIncomeSyncAdapter } from './everflow/everflow-income-sync.adapter';
import { PhotonPayCardSyncAdapter } from './photonpay/photonpay-card-sync.adapter';

@Injectable()
export class SyncAdapterResolver {
  constructor(
    private readonly everflowIncome: EverflowIncomeSyncAdapter,
    private readonly cakeIncome: CakeIncomeSyncAdapter,
    private readonly airwallexCard: AirwallexCardSyncAdapter,
    private readonly photonpayCard: PhotonPayCardSyncAdapter,
  ) {}

  resolve(input: { sourceType: SyncTaskSourceType; platform?: string | null; provider?: Provider | null }): SyncAdapter {
    if (input.sourceType === SyncTaskSourceType.affiliate_income) {
      const platform = normalizeAffiliatePlatform(input.platform);
      if (platform === SyncTaskPlatform.everflow) return this.everflowIncome;
      if (platform === SyncTaskPlatform.cake) return this.cakeIncome;
    }

    if (input.sourceType === SyncTaskSourceType.card_spend) {
      if (input.provider === Provider.airwallex) return this.airwallexCard;
      if (input.provider === Provider.photonpay) return this.photonpayCard;
    }

    throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'No sync adapter is configured for this task.');
  }
}

function normalizeAffiliatePlatform(platform: string | null | undefined): SyncTaskPlatform {
  const normalized = platform?.trim().toLowerCase();
  if (normalized === SyncTaskPlatform.everflow || normalized === SyncTaskPlatform.cake) return normalized;
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'affiliateAccount.platform must be everflow or cake.');
}
