import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  CreateMonthlyCardProviderFeeRateInput,
  MonthlyCardProviderFeeRatesService,
  UpdateMonthlyCardProviderFeeRateInput,
} from './monthly-card-provider-fee-rates.service';

@Controller('monthly-card-provider-fee-rates')
export class MonthlyCardProviderFeeRatesController {
  constructor(private readonly rates: MonthlyCardProviderFeeRatesService) {}

  @Post()
  @RequirePermissions('card_provider_fee_rate.manage')
  create(@Body() body: CreateMonthlyCardProviderFeeRateInput, @CurrentActor() actor: Actor) {
    return this.rates.create(body, actor);
  }

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.rates.list(query);
  }

  @Patch(':id')
  @RequirePermissions('card_provider_fee_rate.manage')
  update(@Param('id') id: string, @Body() body: UpdateMonthlyCardProviderFeeRateInput, @CurrentActor() actor: Actor) {
    return this.rates.update(id, body, actor);
  }

  @Patch(':id/disable')
  @RequirePermissions('card_provider_fee_rate.manage')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.rates.disable(id, actor);
  }
}
