import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MonthlyExchangeRatesController } from './monthly-exchange-rates.controller';
import { MonthlyExchangeRatesService } from './monthly-exchange-rates.service';

@Module({
  imports: [PrismaModule, MonthLockModule, AuditModule],
  controllers: [MonthlyExchangeRatesController],
  providers: [MonthlyExchangeRatesService],
  exports: [MonthlyExchangeRatesService],
})
export class MonthlyExchangeRatesModule {}
