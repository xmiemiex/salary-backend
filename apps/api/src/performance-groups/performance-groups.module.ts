import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PerformanceGroupsController } from './performance-groups.controller';
import { PerformanceGroupsService } from './performance-groups.service';

@Module({
  imports: [PrismaModule, MonthLockModule, AuditModule],
  controllers: [PerformanceGroupsController],
  providers: [PerformanceGroupsService],
  exports: [PerformanceGroupsService],
})
export class PerformanceGroupsModule {}
