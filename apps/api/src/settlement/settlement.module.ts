import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { SettlementCalculatorService } from './settlement-calculator.service';
import { SettlementFinalizationController } from './settlement-finalization.controller';
import { SettlementFinalizationService } from './settlement-finalization.service';
import { SettlementGenerationController } from './settlement-generation.controller';
import { SettlementGenerationService } from './settlement-generation.service';
import { SettlementPreflightService } from './settlement-preflight.service';

@Module({
  imports: [AuditModule, MonthLockModule],
  controllers: [SettlementGenerationController, SettlementFinalizationController],
  providers: [
    SettlementCalculatorService,
    SettlementGenerationService,
    SettlementFinalizationService,
    SettlementPreflightService,
  ],
  exports: [
    SettlementCalculatorService,
    SettlementGenerationService,
    SettlementFinalizationService,
    SettlementPreflightService,
  ],
})
export class SettlementModule {}
