import { Module } from '@nestjs/common';
import { SyncReconciliationModule } from '../sync-reconciliation/sync-reconciliation.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { MonthlyFinanceService } from './monthly-finance.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [SyncReconciliationModule, AuditModule],
  controllers: [DashboardController],
  providers: [DashboardService, MonthlyFinanceService],
})
export class DashboardModule {}
