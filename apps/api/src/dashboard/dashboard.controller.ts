import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { MonthlyFinanceService } from './monthly-finance.service';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService, private readonly finance: MonthlyFinanceService) {}

  @Get('monthly')
  @RequirePermissions('salary.view_all')
  monthly(@Query('settlementMonth') month: string) { return this.finance.read(month); }

  @Get('monthly/status')
  @RequirePermissions('salary.view_all')
  monthlyStatus(@Query('settlementMonth') month: string) { return this.finance.status(month); }

  @Get('monthly/details')
  @RequirePermissions('salary.view_all')
  monthlyDetails(@Query('settlementMonth') month: string, @Query('rowKey') rowKey: string, @Query('page') page: string, @Query('category') category: string) { return this.finance.details(month, rowKey, page, category); }

  @Post('monthly/fees')
  @RequirePermissions('card_provider_fee_rate.manage')
  fees(@Body() body: { settlementMonth: string; rates: Record<string, string> }, @CurrentActor() actor: Actor) { return this.finance.saveFees(body.settlementMonth, body.rates, actor); }

  @Post('monthly/adpos')
  @RequirePermissions('manual_card_spend.manage')
  adpos(@Body() body: { settlementMonth: string; subId: string; amount: string }, @CurrentActor() actor: Actor) { return this.finance.saveAdpos(body.settlementMonth, body.subId, body.amount, actor); }

  @Post('monthly/sub-id')
  @RequirePermissions('sub_id_mapping.manage')
  subId(@Body() body: { settlementMonth: string; rowKey: string; subId: string }, @CurrentActor() actor: Actor) { return this.finance.saveSubId(body.settlementMonth, body.rowKey, body.subId, actor); }

  @Post('monthly/refresh')
  @RequirePermissions('income.import', 'manual_card_spend.manage')
  refresh(@Body() body: { settlementMonth: string; source?: string }, @CurrentActor() actor: Actor) { return this.finance.refresh(body.settlementMonth, actor, body.source); }

  @Get('overview')
  overview(@Query('settlementMonth') settlementMonth: string | undefined, @CurrentActor() actor: Actor) {
    return this.dashboard.overview(settlementMonth, actor);
  }
}
