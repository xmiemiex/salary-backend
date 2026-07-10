import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ManualCardSpendEntriesController } from './manual-card-spend-entries.controller';
import { ManualCardSpendEntriesService } from './manual-card-spend-entries.service';

@Module({
  imports: [PrismaModule, MonthLockModule, AuditModule],
  controllers: [ManualCardSpendEntriesController],
  providers: [ManualCardSpendEntriesService],
  exports: [ManualCardSpendEntriesService],
})
export class ManualCardSpendEntriesModule {}
