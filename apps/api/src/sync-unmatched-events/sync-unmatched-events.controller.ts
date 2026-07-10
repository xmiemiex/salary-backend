import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  ResolveSyncUnmatchedEventInput,
  SyncUnmatchedEventsQuery,
  SyncUnmatchedEventsService,
  UpdateSyncUnmatchedEventResolutionInput,
} from './sync-unmatched-events.service';

@Controller('sync-unmatched-events')
export class SyncUnmatchedEventsController {
  constructor(private readonly unmatchedEvents: SyncUnmatchedEventsService) {}

  @Get()
  @RequirePermissions('salary.view_all')
  list(@Query() query: SyncUnmatchedEventsQuery) {
    return this.unmatchedEvents.list(query);
  }

  @Post(':id/ignore')
  @RequirePermissions('settlement.generate')
  ignore(
    @Param('id') id: string,
    @Body() body: UpdateSyncUnmatchedEventResolutionInput,
    @CurrentActor() actor: Actor,
  ) {
    return this.unmatchedEvents.ignore(id, body, actor);
  }

  @Post(':id/resolve')
  @RequirePermissions('settlement.generate')
  resolve(@Param('id') id: string, @Body() body: ResolveSyncUnmatchedEventInput, @CurrentActor() actor: Actor) {
    return this.unmatchedEvents.resolve(id, body, actor);
  }
}
