import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { parseSettlementMonthParam } from './settlement-month.util';
import { LockSettlementInput, SettlementFinalizationService } from './settlement-finalization.service';

@Controller('settlements')
export class SettlementFinalizationController {
  constructor(private readonly finalization: SettlementFinalizationService) {}

  @Post(':month/confirm')
  @RequirePermissions('settlement.generate')
  confirm(@Param('month') month: string, @CurrentActor() actor: Actor) {
    return this.finalization.confirmSettlement(parseSettlementMonthParam(month), actor);
  }

  @Post(':month/lock')
  @RequirePermissions('settlement.lock')
  lock(@Param('month') month: string, @Body() body: LockSettlementInput, @CurrentActor() actor: Actor) {
    return this.finalization.lockSettlement(parseSettlementMonthParam(month), actor, body);
  }

  @Get(':month')
  @RequirePermissions('salary.view_all')
  get(@Param('month') month: string) {
    return this.finalization.getSettlementSummary(parseSettlementMonthParam(month));
  }

  @Get(':month/details')
  @RequirePermissions('salary.view_all')
  details(@Param('month') month: string, @Query() query: Record<string, string>) {
    return this.finalization.getSettlementDetails(parseSettlementMonthParam(month), query);
  }

  @Get(':month/export')
  @RequirePermissions('salary.export')
  export(@Param('month') month: string, @CurrentActor() actor: Actor) {
    return this.finalization.exportSettlementCsv(parseSettlementMonthParam(month), actor);
  }
}
