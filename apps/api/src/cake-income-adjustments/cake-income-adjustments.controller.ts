import { Body, Controller, Get, Param, Patch, Post, Query, StreamableFile } from '@nestjs/common';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  CakeIncomeAdjustmentQuery,
  CakeIncomeAdjustmentsService,
  SaveCakeIncomeAdjustmentInput,
} from './cake-income-adjustments.service';

@Controller('cake-income-adjustments')
@RequirePermissions('income.import')
export class CakeIncomeAdjustmentsController {
  constructor(private readonly adjustments: CakeIncomeAdjustmentsService) {}

  @Get()
  list(@Query() query: CakeIncomeAdjustmentQuery, @CurrentActor() actor: Actor) {
    return this.adjustments.list(query, actor);
  }

  @Get('export.csv')
  async exportCsv(@Query() query: CakeIncomeAdjustmentQuery, @CurrentActor() actor: Actor) {
    const result = await this.adjustments.exportCsv(query, actor);
    return new StreamableFile(Buffer.from(result.csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${result.filename}"`,
    });
  }

  @Post()
  saveDraft(@Body() body: SaveCakeIncomeAdjustmentInput, @CurrentActor() actor: Actor) {
    return this.adjustments.saveDraft(body, actor);
  }

  @Patch(':id/confirm')
  confirm(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.adjustments.confirm(id, actor);
  }

  @Patch(':id/disable')
  disable(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.adjustments.disable(id, actor);
  }
}
