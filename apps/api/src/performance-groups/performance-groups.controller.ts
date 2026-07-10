import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  CreatePerformanceGroupInput,
  PerformanceGroupsService,
  UpdatePerformanceGroupInput,
} from './performance-groups.service';

@Controller('performance-groups')
export class PerformanceGroupsController {
  constructor(private readonly groups: PerformanceGroupsService) {}

  @Post()
  @RequirePermissions('performance_group.manage')
  create(@Body() body: CreatePerformanceGroupInput, @CurrentActor() actor: Actor) {
    return this.groups.create(body, actor);
  }

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.groups.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.groups.get(id);
  }

  @Patch(':id')
  @RequirePermissions('performance_group.manage')
  update(@Param('id') id: string, @Body() body: UpdatePerformanceGroupInput, @CurrentActor() actor: Actor) {
    return this.groups.update(id, body, actor);
  }

  @Patch(':id/disable')
  @RequirePermissions('performance_group.manage')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.groups.disable(id, actor);
  }
}
