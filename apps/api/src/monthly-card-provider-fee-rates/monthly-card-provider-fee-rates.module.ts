import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MonthlyCardProviderFeeRatesController } from './monthly-card-provider-fee-rates.controller';
import { MonthlyCardProviderFeeRatesService } from './monthly-card-provider-fee-rates.service';

@Module({
  imports: [PrismaModule, MonthLockModule, AuditModule],
  controllers: [MonthlyCardProviderFeeRatesController],
  providers: [MonthlyCardProviderFeeRatesService],
  exports: [MonthlyCardProviderFeeRatesService],
})
export class MonthlyCardProviderFeeRatesModule {}
