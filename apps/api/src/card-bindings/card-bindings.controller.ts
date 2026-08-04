import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { CardBindingsService, CreateCardBindingInput, UpdateCardBindingInput } from './card-bindings.service';
import { AirwallexCardDiscoveryService } from './airwallex-card-discovery.service';

@Controller('card-bindings')
export class CardBindingsController {
  constructor(
    private readonly bindings: CardBindingsService,
    private readonly airwallexDiscovery: AirwallexCardDiscoveryService,
  ) {}

  @Post()
  @RequirePermissions('card_binding.manage')
  create(@Body() body: CreateCardBindingInput, @CurrentActor() actor: Actor) {
    return this.bindings.create(body, actor);
  }

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.bindings.list(query);
  }

  @Get('airwallex/discovery')
  @RequirePermissions('card_binding.manage')
  discoverAirwallexCards() {
    return this.airwallexDiscovery.discover();
  }

  @Patch(':id')
  @RequirePermissions('card_binding.manage')
  update(@Param('id') id: string, @Body() body: UpdateCardBindingInput, @CurrentActor() actor: Actor) {
    return this.bindings.update(id, body, actor);
  }

  @Patch(':id/disable')
  @RequirePermissions('card_binding.manage')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.bindings.disable(id, actor);
  }
}
