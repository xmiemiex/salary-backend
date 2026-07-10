import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  AdminUsersService,
  CreateAdminUserInput,
  ResetAdminPasswordInput,
  UpdateAdminUserInput,
} from './admin-users.service';

@Controller('admin-users')
export class AdminUsersController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @Get()
  @RequirePermissions('admin_users.read')
  list(@Query() query: Record<string, unknown>) {
    return this.adminUsers.list(query);
  }

  @Get('roles')
  @RequirePermissions('admin_users.read')
  listRoles() {
    return this.adminUsers.listRoles();
  }

  @Get(':id')
  @RequirePermissions('admin_users.read')
  get(@Param('id') id: string) {
    return this.adminUsers.get(id);
  }

  @Post()
  @RequirePermissions('admin_users.manage')
  create(@Body() input: CreateAdminUserInput, @CurrentActor() actor: Actor) {
    return this.adminUsers.create(input, actor);
  }

  @Patch(':id')
  @RequirePermissions('admin_users.manage')
  update(@Param('id') id: string, @Body() input: UpdateAdminUserInput, @CurrentActor() actor: Actor) {
    return this.adminUsers.update(id, input, actor);
  }

  @Post(':id/reset-password')
  @RequirePermissions('admin_users.manage')
  resetPassword(@Param('id') id: string, @Body() input: ResetAdminPasswordInput, @CurrentActor() actor: Actor) {
    return this.adminUsers.resetPassword(id, input, actor);
  }

  @Post(':id/enable')
  @RequirePermissions('admin_users.manage')
  enable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.adminUsers.setEnabled(id, true, actor);
  }

  @Post(':id/disable')
  @RequirePermissions('admin_users.manage')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.adminUsers.setEnabled(id, false, actor);
  }
}
