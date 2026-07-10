import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  CreateManualCardSpendEntryInput,
  ManualCardSpendEntriesService,
  UpdateManualCardSpendEntryInput,
} from './manual-card-spend-entries.service';

@Controller('manual-card-spend-entries')
export class ManualCardSpendEntriesController {
  constructor(private readonly entries: ManualCardSpendEntriesService) {}

  @Post()
  @RequirePermissions('manual_card_spend.manage')
  create(@Body() body: CreateManualCardSpendEntryInput, @CurrentActor() actor: Actor) {
    return this.entries.create(body, actor);
  }

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.entries.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.entries.get(id);
  }

  @Patch(':id')
  @RequirePermissions('manual_card_spend.manage')
  update(@Param('id') id: string, @Body() body: UpdateManualCardSpendEntryInput, @CurrentActor() actor: Actor) {
    return this.entries.update(id, body, actor);
  }

  @Patch(':id/confirm')
  @RequirePermissions('manual_card_spend.manage')
  confirm(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.entries.confirm(id, actor);
  }

  @Patch(':id/disable')
  @RequirePermissions('manual_card_spend.manage')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.entries.disable(id, actor);
  }
}
