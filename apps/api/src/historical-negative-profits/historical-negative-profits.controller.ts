import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  CreateHistoricalNegativeProfitInput,
  HistoricalNegativeProfitsService,
  UpdateHistoricalNegativeProfitInput,
} from './historical-negative-profits.service';

@Controller('historical-negative-profits')
export class HistoricalNegativeProfitsController {
  constructor(private readonly profits: HistoricalNegativeProfitsService) {}

  @Post()
  @RequirePermissions('historical_negative_profit.manage')
  create(@Body() body: CreateHistoricalNegativeProfitInput, @CurrentActor() actor: Actor) {
    return this.profits.create(body, actor);
  }

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.profits.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.profits.get(id);
  }

  @Patch(':id')
  @RequirePermissions('historical_negative_profit.manage')
  update(@Param('id') id: string, @Body() body: UpdateHistoricalNegativeProfitInput, @CurrentActor() actor: Actor) {
    return this.profits.update(id, body, actor);
  }

  @Patch(':id/disable')
  @RequirePermissions('historical_negative_profit.manage')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.profits.disable(id, actor);
  }
}
