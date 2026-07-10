import { Module } from '@nestjs/common';
import { SyncReconciliationModule } from '../sync-reconciliation/sync-reconciliation.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [SyncReconciliationModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
