import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MonthLockService } from './month-lock.service';

@Module({
  imports: [AuditModule],
  providers: [MonthLockService],
  exports: [MonthLockService],
})
export class MonthLockModule {}
