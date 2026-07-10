import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Actor } from '../auth/auth.types';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@RequirePermissions('notifications.read')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query() query: Record<string, unknown>) {
    return this.notifications.list(actor, query);
  }

  @Get('unread-count')
  unreadCount(@CurrentActor() actor: Actor) {
    return this.notifications.unreadCount(actor);
  }

  @Post(':id/read')
  markRead(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.notifications.markRead(id, actor);
  }

  @Post('read-all')
  markAllRead(@CurrentActor() actor: Actor) {
    return this.notifications.markAllRead(actor);
  }
}
