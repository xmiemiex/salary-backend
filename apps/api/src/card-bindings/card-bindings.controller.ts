import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { CardBindingsService, CreateCardBindingInput, UpdateCardBindingInput } from './card-bindings.service';

@Controller('card-bindings')
export class CardBindingsController {
  constructor(private readonly bindings: CardBindingsService) {}

  @Post()
  @RequirePermissions('card_binding.manage')
  create(@Body() body: CreateCardBindingInput, @CurrentActor() actor: Actor) {
    return this.bindings.create(body, actor);
  }

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.bindings.list(query);
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
