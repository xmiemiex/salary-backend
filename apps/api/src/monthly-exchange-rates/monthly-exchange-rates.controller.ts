import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  CreateMonthlyExchangeRateInput,
  MonthlyExchangeRatesService,
  UpdateMonthlyExchangeRateInput,
} from './monthly-exchange-rates.service';

@Controller('monthly-exchange-rates')
export class MonthlyExchangeRatesController {
  constructor(private readonly rates: MonthlyExchangeRatesService) {}

  @Post()
  @RequirePermissions('monthly_exchange_rate.manage')
  create(@Body() body: CreateMonthlyExchangeRateInput, @CurrentActor() actor: Actor) {
    return this.rates.create(body, actor);
  }

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.rates.list(query);
  }

  @Patch(':id')
  @RequirePermissions('monthly_exchange_rate.manage')
  update(@Param('id') id: string, @Body() body: UpdateMonthlyExchangeRateInput, @CurrentActor() actor: Actor) {
    return this.rates.update(id, body, actor);
  }

  @Patch(':id/disable')
  @RequirePermissions('monthly_exchange_rate.manage')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.rates.disable(id, actor);
  }
}
