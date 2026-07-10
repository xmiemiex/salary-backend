import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  CreateManualIncomeRecordInput,
  ManualIncomeRecordsService,
  UpdateManualIncomeRecordInput,
} from './manual-income-records.service';

@Controller('manual-income-records')
export class ManualIncomeRecordsController {
  constructor(private readonly records: ManualIncomeRecordsService) {}

  @Post()
  @RequirePermissions('income.import')
  create(@Body() body: CreateManualIncomeRecordInput, @CurrentActor() actor: Actor) {
    return this.records.create(body, actor);
  }

  @Get()
  list(@Query() query: Record<string, string>) {
    return this.records.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.records.get(id);
  }

  @Patch(':id')
  @RequirePermissions('income.import')
  update(@Param('id') id: string, @Body() body: UpdateManualIncomeRecordInput, @CurrentActor() actor: Actor) {
    return this.records.update(id, body, actor);
  }

  @Patch(':id/confirm')
  @RequirePermissions('income.import')
  confirm(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.records.confirm(id, actor);
  }

  @Patch(':id/disable')
  @RequirePermissions('income.import')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.records.disable(id, actor);
  }
}
