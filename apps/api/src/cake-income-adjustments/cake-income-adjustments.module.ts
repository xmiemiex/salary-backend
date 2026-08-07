import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CakeIncomeAdjustmentsController } from './cake-income-adjustments.controller';
import { CakeIncomeAdjustmentsService } from './cake-income-adjustments.service';

@Module({
  imports: [PrismaModule, MonthLockModule, AuditModule],
  controllers: [CakeIncomeAdjustmentsController],
  providers: [CakeIncomeAdjustmentsService],
})
export class CakeIncomeAdjustmentsModule {}
