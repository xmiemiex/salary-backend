import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { ERROR_CODES } from '@salary/shared';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { AppError } from '../common/app-error';
import { ProviderCardInventoryService } from './provider-card-inventory.service';

@Controller('card-bindings')
export class CardBindingsController {
  constructor(
    private readonly inventory: ProviderCardInventoryService,
  ) {}

  @Get()
  @RequirePermissions('card_binding.manage')
  list(@Query() query: Record<string, string>) {
    return this.inventory.list(query);
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
