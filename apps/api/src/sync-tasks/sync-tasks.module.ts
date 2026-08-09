import { Module } from '@nestjs/common';
import { ApiCredentialsModule } from '../api-credentials/api-credentials.module';
import { CardBindingsModule } from '../card-bindings/card-bindings.module';
import { AuditModule } from '../audit/audit.module';
import { MonthLockModule } from '../month-lock/month-lock.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncUnmatchedEventsModule } from '../sync-unmatched-events/sync-unmatched-events.module';
import { SyncAdapterResolver } from './sync-adapter-resolver';
import { AirwallexCardSyncAdapter } from './airwallex/airwallex-card-sync.adapter';
import { CakeClient } from './cake/cake-client';
import { CakeIncomeSyncAdapter } from './cake/cake-income-sync.adapter';
import { CakeCalibrationService } from './cake/cake-calibration.service';
import { EverflowClient } from './everflow/everflow-client';
import { EverflowIncomeSyncAdapter } from './everflow/everflow-income-sync.adapter';
import { EverflowCalibrationService } from './everflow/everflow-calibration.service';
import { PhotonPayCardSyncAdapter } from './photonpay/photonpay-card-sync.adapter';
import { SyncTaskExecutionService } from './sync-task-execution.service';
import { SyncTaskOperationsService } from './sync-task-operations.service';
import { SyncTasksController } from './sync-tasks.controller';
import { SyncTasksService } from './sync-tasks.service';
import { SyncPlanningController } from './sync-planning.controller';
import { SyncPlanningService } from './sync-planning.service';
import { SyncPlannerScheduler } from './sync-planner.scheduler';
import { SyncAutoExecutionController } from './sync-auto-execution.controller';
import { SyncAutoExecutionService } from './sync-auto-execution.service';
import { SyncAutoExecutorScheduler } from './sync-auto-executor.scheduler';

@Module({
  imports: [PrismaModule, AuditModule, MonthLockModule, ApiCredentialsModule, SyncUnmatchedEventsModule, CardBindingsModule],
  controllers: [SyncTasksController, SyncPlanningController, SyncAutoExecutionController],
  providers: [
    SyncTasksService,
    SyncPlanningService,
    SyncPlannerScheduler,
    SyncTaskExecutionService,
    SyncTaskOperationsService,
    SyncAutoExecutionService,
    SyncAutoExecutorScheduler,
    SyncAdapterResolver,
    EverflowClient,
    EverflowIncomeSyncAdapter,
    EverflowCalibrationService,
    CakeClient,
    CakeCalibrationService,
    CakeIncomeSyncAdapter,
    AirwallexCardSyncAdapter,
    PhotonPayCardSyncAdapter,
  ],
})
export class SyncTasksModule {}
