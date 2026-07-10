import { Controller, Get, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('overview')
  overview(@Query('settlementMonth') settlementMonth: string | undefined, @CurrentActor() actor: Actor) {
    return this.dashboard.overview(settlementMonth, actor);
  }
}
