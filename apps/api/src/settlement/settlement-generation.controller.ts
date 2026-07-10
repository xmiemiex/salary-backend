import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AttendanceStatus } from '@prisma/client';
import { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { SettlementGenerationService } from './settlement-generation.service';
import { SettlementPreflightService } from './settlement-preflight.service';

type GenerateSettlementBody = {
  attendanceByEmployeeId?: Record<string, AttendanceStatus>;
  acknowledgedWarningCodes?: unknown;
};

@Controller('settlements')
export class SettlementGenerationController {
  constructor(
    private readonly generation: SettlementGenerationService,
    private readonly preflight: SettlementPreflightService,
  ) {}

  @Get('preflight')
  @RequirePermissions('salary.view_all')
  checkPreflight(@Query('settlementMonth') settlementMonth: string) {
    return this.preflight.check(this.preflight.parseSettlementMonth(settlementMonth));
  }

  @Post(':month/generate')
  @RequirePermissions('settlement.generate')
  generate(@Param('month') month: string, @Body() body: GenerateSettlementBody, @CurrentActor() actor: Actor) {
    return this.generation.generateSettlement({
      settlementMonth: this.preflight.parseSettlementMonth(month),
      actor,
      attendanceByEmployeeId: body?.attendanceByEmployeeId,
      acknowledgedWarningCodes: body?.acknowledgedWarningCodes,
    });
  }
}
