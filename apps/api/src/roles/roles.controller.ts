import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { CreateRoleInput, RolesService, UpdateRoleInput } from './roles.service';

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get() @RequirePermissions('role.read')
  list(@Query() query: Record<string, unknown>) { return this.roles.list(query); }

  @Get('permissions') @RequirePermissions('role.read')
  permissions() { return this.roles.permissions(); }

  @Get(':id') @RequirePermissions('role.read')
  get(@Param('id') id: string) { return this.roles.get(id); }

  @Post() @RequirePermissions('role.manage')
  create(@Body() input: CreateRoleInput, @CurrentActor() actor: Actor) { return this.roles.create(input, actor); }

  @Patch(':id') @RequirePermissions('role.manage')
  update(@Param('id') id: string, @Body() input: UpdateRoleInput, @CurrentActor() actor: Actor) { return this.roles.update(id, input, actor); }

  @Post(':id/enable') @RequirePermissions('role.manage')
  enable(@Param('id') id: string, @CurrentActor() actor: Actor) { return this.roles.setEnabled(id, true, actor); }

  @Post(':id/disable') @RequirePermissions('role.manage')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) { return this.roles.setEnabled(id, false, actor); }
}
