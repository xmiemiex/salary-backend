import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { SyncTaskTriggerType } from '@prisma/client';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequireAnyPermissions, RequirePermissions } from '../auth/require-permissions.decorator';
import { SyncPlanningService } from './sync-planning.service';

@Controller('sync-planning')
export class SyncPlanningController {
  constructor(private readonly planning: SyncPlanningService) {}

  @Get('preview')
  @RequireAnyPermissions('salary.view_all', 'income.import', 'manual_card_spend.manage')
  preview(@Query('settlementMonth') month: string) { return this.planning.preview(month); }

  @Post('generate')
  @RequirePermissions('income.import', 'manual_card_spend.manage')
  generate(@Body() body: { settlementMonth: string }, @CurrentActor() actor: Actor) {
    return this.planning.generate(body?.settlementMonth, actor, SyncTaskTriggerType.manual);
  }

  @Get('status')
  @RequireAnyPermissions('salary.view_all', 'income.import', 'manual_card_spend.manage')
  status() { return this.planning.status(); }
}
