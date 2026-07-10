import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Actor } from '../auth/auth.types';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { AlertsService } from './alerts.service';

@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @RequirePermissions('alerts.read')
  list(@Query() query: Record<string, unknown>) {
    return this.alerts.list(query);
  }

  @Get(':id')
  @RequirePermissions('alerts.read')
  get(@Param('id') id: string) {
    return this.alerts.get(id);
  }

  @Post('scan')
  @RequirePermissions('alerts.manage')
  scan(@CurrentActor() actor: Actor) {
    return this.alerts.scan(actor);
  }

  @Post(':id/acknowledge')
  @RequirePermissions('alerts.manage')
  acknowledge(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.alerts.acknowledge(id, actor);
  }

  @Post(':id/silence')
  @RequirePermissions('alerts.manage')
  silence(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.alerts.silence(id, body, actor);
  }
}
