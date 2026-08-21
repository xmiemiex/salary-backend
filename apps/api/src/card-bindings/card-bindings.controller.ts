import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequireAnyPermissions, RequirePermissions } from '../auth/require-permissions.decorator';
import { AppError } from '../common/app-error';
import { ProviderCardInventoryService } from './provider-card-inventory.service';
import {
  AliasCorrectionInput,
  AliasWriteInput,
  ExclusionWriteInput,
  PhotonPayCardGovernanceService,
} from './photonpay-card-governance.service';

@Controller('card-bindings')
export class CardBindingsController {
  constructor(
    private readonly inventory: ProviderCardInventoryService,
    private readonly governance: PhotonPayCardGovernanceService,
  ) {}

  @Get()
  @RequireAnyPermissions('card_binding.manage', 'photonpay_unmatched.read', 'photonpay_email_alias.manage', 'provider_card_exclusion.manage')
  list(@Query() query: Record<string, string>, @CurrentActor() actor: Actor) {
    return this.inventory.list(query, actor);
  }

  @Get('photonpay/unmatched-groups')
  @RequirePermissions('photonpay_unmatched.read')
  unmatchedGroups() {
    return this.governance.listUnmatchedGroups();
  }

  @Get('photonpay/summary')
  @RequirePermissions('photonpay_unmatched.read')
  photonPaySummary() {
    return this.governance.safeSummary();
  }

  @Get('photonpay/employee-options')
  @RequirePermissions('photonpay_email_alias.manage')
  photonPayEmployeeOptions() {
    return this.governance.listEmployeeOptions();
  }

  @Get('photonpay/aliases')
  @RequirePermissions('photonpay_email_alias.manage')
  aliases() {
    return this.governance.listAliases();
  }

  @Post('photonpay/aliases/preview')
  @RequirePermissions('photonpay_unmatched.read', 'photonpay_email_alias.manage')
  previewAlias(@Body() input: AliasWriteInput) {
    return this.governance.previewAlias(input);
  }

  @Post('photonpay/aliases')
  @RequirePermissions('photonpay_email_alias.manage', 'photonpay_rematch.execute')
  createAlias(@Body() input: AliasWriteInput, @CurrentActor() actor: Actor) {
    return this.governance.createAlias(input, actor);
  }

  @Patch('photonpay/aliases/:id')
  @RequirePermissions('photonpay_email_alias.manage', 'photonpay_rematch.execute')
  correctAlias(@Param('id') id: string, @Body() input: AliasCorrectionInput, @CurrentActor() actor: Actor) {
    return this.governance.correctAlias(id, input, actor);
  }

  @Post('photonpay/aliases/:id/preview')
  @RequirePermissions('photonpay_email_alias.manage')
  previewAliasCorrection(@Param('id') id: string, @Body() input: AliasCorrectionInput) {
    return this.governance.previewAliasCorrection(id, input);
  }

  @Post('photonpay/aliases/:id/disable')
  @RequirePermissions('photonpay_email_alias.manage', 'photonpay_rematch.execute')
  disableAlias(@Param('id') id: string, @Body() input: { confirm?: boolean }, @CurrentActor() actor: Actor) {
    return this.governance.disableAlias(id, input, actor);
  }

  @Post('photonpay/aliases/:id/disable/preview')
  @RequirePermissions('photonpay_email_alias.manage')
  previewDisableAlias(@Param('id') id: string) {
    return this.governance.previewDisableAlias(id);
  }

  @Get('photonpay/rematch/preview')
  @RequirePermissions('photonpay_unmatched.read')
  previewRematch() {
    return this.governance.previewRematch();
  }

  @Post('photonpay/rematch')
  @RequirePermissions('photonpay_rematch.execute')
  rematch(@Body() input: { confirm?: boolean }, @CurrentActor() actor: Actor) {
    return this.governance.executeRematch(input, actor);
  }

  @Get('photonpay/exclusions')
  @RequirePermissions('provider_card_exclusion.manage')
  exclusions() {
    return this.governance.listExclusions();
  }

  @Post('photonpay/exclusions/preview')
  @RequirePermissions('provider_card_exclusion.manage')
  previewExclusion(@Body() input: ExclusionWriteInput) {
    return this.governance.previewExclusion(input);
  }

  @Post('photonpay/exclusions')
  @RequirePermissions('provider_card_exclusion.manage')
  createExclusion(@Body() input: ExclusionWriteInput, @CurrentActor() actor: Actor) {
    return this.governance.createExclusion(input, actor);
  }

  @Post('photonpay/exclusions/:id/disable')
  @RequirePermissions('provider_card_exclusion.manage')
  disableExclusion(@Param('id') id: string, @Body() input: { confirm?: boolean }, @CurrentActor() actor: Actor) {
    return this.governance.disableExclusion(id, input, actor);
  }

  @Post('sync')
  @RequirePermissions('card_binding.manage')
  syncAll(@CurrentActor() actor: Actor) {
    return this.inventory.syncAll(actor);
  }

  @Post('sync/:provider')
  @RequirePermissions('card_binding.manage')
  syncProvider(@Param('provider') provider: string, @CurrentActor() actor: Actor) {
    if (provider !== Provider.airwallex && provider !== Provider.photonpay) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'provider must be airwallex or photonpay.');
    }
    return this.inventory.syncProvider(provider, actor);
  }
}
