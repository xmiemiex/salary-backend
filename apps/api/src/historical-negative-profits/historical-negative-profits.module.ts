import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { HistoricalNegativeProfitsController } from './historical-negative-profits.controller';
import { HistoricalNegativeProfitsService } from './historical-negative-profits.service';

@Module({
  imports: [PrismaModule, MonthLockModule, AuditModule],
  controllers: [HistoricalNegativeProfitsController],
  providers: [HistoricalNegativeProfitsService],
  exports: [HistoricalNegativeProfitsService],
})
export class HistoricalNegativeProfitsModule {}
