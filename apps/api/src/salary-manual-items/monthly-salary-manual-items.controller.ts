import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  CreateMonthlySalaryManualItemInput,
  MonthlySalaryManualItemsService,
  UpdateMonthlySalaryManualItemInput,
} from './monthly-salary-manual-items.service';

@Controller('monthly-salary-manual-items')
export class MonthlySalaryManualItemsController {
  constructor(private readonly items: MonthlySalaryManualItemsService) {}

  @Post()
  @RequirePermissions('salary_manual_item.manage')
  create(@Body() body: CreateMonthlySalaryManualItemInput, @CurrentActor() actor: Actor) {
    return this.items.create(body, actor);
  }

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.items.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.items.get(id);
  }

  @Patch(':id')
  @RequirePermissions('salary_manual_item.manage')
  update(@Param('id') id: string, @Body() body: UpdateMonthlySalaryManualItemInput, @CurrentActor() actor: Actor) {
    return this.items.update(id, body, actor);
  }

  @Patch(':id/disable')
  @RequirePermissions('salary_manual_item.manage')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.items.disable(id, actor);
  }
}
