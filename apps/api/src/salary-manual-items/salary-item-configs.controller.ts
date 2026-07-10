import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  CreateSalaryItemConfigInput,
  SalaryItemConfigsService,
  UpdateSalaryItemConfigInput,
} from './salary-item-configs.service';

@Controller('salary-item-configs')
export class SalaryItemConfigsController {
  constructor(private readonly configs: SalaryItemConfigsService) {}

  @Post()
  @RequirePermissions('salary_item_config.manage')
  create(@Body() body: CreateSalaryItemConfigInput, @CurrentActor() actor: Actor) {
    return this.configs.create(body, actor);
  }

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.configs.list(query);
  }

  @Patch(':id')
  @RequirePermissions('salary_item_config.manage')
  update(@Param('id') id: string, @Body() body: UpdateSalaryItemConfigInput, @CurrentActor() actor: Actor) {
    return this.configs.update(id, body, actor);
  }

  @Patch(':id/disable')
  @RequirePermissions('salary_item_config.manage')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.configs.disable(id, actor);
  }
}
