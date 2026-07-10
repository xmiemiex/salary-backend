import { Body, Controller, Get, Param, Patch, Put } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequireAnyPermissions, RequirePermissions } from '../auth/require-permissions.decorator';
import { ApiCredentialsService, UpsertApiCredentialInput } from './api-credentials.service';

@Controller('api-credentials')
export class ApiCredentialsController {
  constructor(private readonly credentials: ApiCredentialsService) {}

  @Get('affiliate-accounts')
  @RequireAnyPermissions('api_config.manage', 'salary.view_all')
  listAffiliateAccounts() {
    return this.credentials.listAffiliateAccounts();
  }

  @Get('affiliate-accounts/:affiliateAccountId')
  @RequireAnyPermissions('api_config.manage', 'salary.view_all')
  getAffiliateAccount(@Param('affiliateAccountId') affiliateAccountId: string) {
    return this.credentials.getAffiliateAccount(affiliateAccountId);
  }

  @Put('affiliate-accounts/:affiliateAccountId')
  @RequirePermissions('api_config.manage')
  upsertAffiliateAccount(
    @Param('affiliateAccountId') affiliateAccountId: string,
    @Body() body: UpsertApiCredentialInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.credentials.upsertAffiliateAccount(affiliateAccountId, body, actor);
  }

  @Patch('affiliate-accounts/:affiliateAccountId/disable')
  @RequirePermissions('api_config.manage')
  disableAffiliateAccount(@Param('affiliateAccountId') affiliateAccountId: string, @CurrentActor() actor: Actor) {
    return this.credentials.disableAffiliateAccount(affiliateAccountId, actor);
  }

  @Get('card-providers')
  @RequireAnyPermissions('api_config.manage', 'salary.view_all')
  listCardProviders() {
    return this.credentials.listCardProviders();
  }

  @Get('card-providers/:provider')
  @RequireAnyPermissions('api_config.manage', 'salary.view_all')
  getCardProvider(@Param('provider') provider: string) {
    return this.credentials.getCardProvider(provider);
  }

  @Put('card-providers/:provider')
  @RequirePermissions('api_config.manage')
  upsertCardProvider(
    @Param('provider') provider: string,
    @Body() body: UpsertApiCredentialInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.credentials.upsertCardProvider(provider, body, actor);
  }

  @Patch('card-providers/:provider/disable')
  @RequirePermissions('api_config.manage')
  disableCardProvider(@Param('provider') provider: string, @CurrentActor() actor: Actor) {
    return this.credentials.disableCardProvider(provider, actor);
  }
}
