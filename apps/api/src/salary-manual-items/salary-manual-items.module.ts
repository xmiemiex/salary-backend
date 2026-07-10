import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MonthlySalaryManualItemsController } from './monthly-salary-manual-items.controller';
import { MonthlySalaryManualItemsService } from './monthly-salary-manual-items.service';
import { SalaryItemConfigsController } from './salary-item-configs.controller';
import { SalaryItemConfigsService } from './salary-item-configs.service';

@Module({
  imports: [PrismaModule, MonthLockModule, AuditModule],
  controllers: [SalaryItemConfigsController, MonthlySalaryManualItemsController],
  providers: [SalaryItemConfigsService, MonthlySalaryManualItemsService],
  exports: [SalaryItemConfigsService, MonthlySalaryManualItemsService],
})
export class SalaryManualItemsModule {}
