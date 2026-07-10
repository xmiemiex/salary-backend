import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ManualIncomeRecordsController } from './manual-income-records.controller';
import { ManualIncomeRecordsService } from './manual-income-records.service';

@Module({
  imports: [PrismaModule, MonthLockModule, AuditModule],
  controllers: [ManualIncomeRecordsController],
  providers: [ManualIncomeRecordsService],
  exports: [ManualIncomeRecordsService],
})
export class ManualIncomeRecordsModule {}
